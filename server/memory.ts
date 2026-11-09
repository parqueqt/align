import type {MemoryEntry, MemoryKind, MemoryVersion} from '../shared/types.ts';
import type {App, GBrainPage, MemoryRead, MemoryService, PublishInput, PublishResult, SessionRow, StoredMemory} from './contracts.ts';

const WATCH_INTERVAL_MS = 20_000;
const SEARCH_LIMIT = 10;
const KEY = /^[a-z0-9][a-z0-9._-]*$/;
const SLUG = /^align\/[^/]+\/(decision|convention|rule|context)\/([^/]+)$/;

interface PageTarget {
  key: string;
  kind: MemoryKind;
  slug: string;
}

/** GBrain lowercases slugs, so a key has to be lowercase to be found again. */
export function normalizeKey(raw: string): string {
  const key = raw.trim().toLowerCase();
  if (!KEY.test(key)) throw new Error(`Invalid key "${raw}": use only letters, digits, dot, dash and underscore`);
  return key;
}

// GBrain trims bodies, so a raw comparison would see differences that are not there.
function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, '\n').trim();
}

function projectPrefix(projectId: string): string {
  return `align/${projectId}/`.toLowerCase();
}

function parseSlug(slug: string, projectId: string): PageTarget | null {
  if (!slug.startsWith(projectPrefix(projectId))) return null;
  const match = SLUG.exec(slug);
  return match ? {kind: match[1] as MemoryKind, key: match[2]!, slug} : null;
}

function renderPage(projectId: string, kind: MemoryKind, key: string, title: string, version: number, body: string): string {
  return [
    '---',
    `title: ${JSON.stringify(title)}`,
    'type: concept',
    `tags: [align, ${kind}]`,
    `align_project: ${JSON.stringify(projectId)}`,
    `align_kind: ${kind}`,
    `align_key: ${JSON.stringify(key)}`,
    `align_version: ${version}`,
    '---',
    '',
    body,
    '',
  ].join('\n');
}

function toEntry({gbrainRevision: _revision, gbrainUpdatedAt: _updatedAt, ...entry}: StoredMemory): MemoryEntry {
  return entry;
}

function toVersion(entry: StoredMemory): MemoryVersion {
  return {key: entry.key, version: entry.version, title: entry.title, body: entry.body, authorSessionId: entry.authorSessionId, createdAt: entry.updatedAt};
}

export function createMemory(app: App): MemoryService {
  let chain: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;
  let ticking = false;

  function locked<T>(operation: () => Promise<T>): Promise<T> {
    const run = chain.then(operation, operation);
    chain = run.catch(() => {});
    return run;
  }

  function requireProject() {
    const project = app.store.getProject();
    if (!project) throw new Error('No project is configured');
    return project;
  }

  function linkActor(actor: SessionRow | null, key: string, version: number): void {
    if (actor?.taskId) app.store.linkTaskDecision(actor.taskId, key, version);
  }

  function recordVersion(entry: StoredMemory, previous: MemoryVersion | null, actor: SessionRow | null): void {
    app.store.upsertMemory(entry);
    app.store.addMemoryVersion(toVersion(entry));
    linkActor(actor, entry.key, entry.version);
    app.store.addActivity({
      type: previous ? 'memory_updated' : 'memory_published',
      actorSessionId: actor?.id ?? null,
      taskId: actor?.taskId ?? null,
      subject: entry.key,
      data: {from: previous?.version ?? 0, to: entry.version, title: entry.title},
    });
    app.coordination.onMemoryChanged(toEntry(entry), previous, actor?.id ?? null);
    app.bus.touch();
  }

  /** Brings the mirror in line with what GBrain holds; a changed body from outside Align is a new version with a null actor. */
  function reconcile(target: PageTarget, stored: StoredMemory | null, page: GBrainPage, updatedAt: string): StoredMemory {
    const body = normalizeBody(page.body);
    const now = Date.now();
    if (!stored) {
      const entry: StoredMemory = {
        key: target.key,
        kind: target.kind,
        title: page.title,
        body,
        version: 1,
        gbrainSlug: target.slug,
        authorSessionId: null,
        updatedAt: now,
        gbrainRevision: page.revision,
        gbrainUpdatedAt: updatedAt,
      };
      recordVersion(entry, null, null);
      return entry;
    }

    if (page.revision === stored.gbrainRevision || body === stored.body) {
      // A revision can move with an unchanged body; keeping it current is what lets the next publish through.
      const synced = {...stored, title: page.title || stored.title, gbrainRevision: page.revision, gbrainUpdatedAt: updatedAt};
      app.store.upsertMemory(synced);
      return synced;
    }

    const entry: StoredMemory = {
      ...stored,
      title: page.title || stored.title,
      body,
      version: stored.version + 1,
      authorSessionId: null,
      updatedAt: now,
      gbrainRevision: page.revision,
      gbrainUpdatedAt: updatedAt,
    };
    recordVersion(entry, toVersion(stored), null);
    return entry;
  }

  async function syncPages(): Promise<void> {
    const project = app.store.getProject();
    if (!project || !app.gbrain.ready()) return;
    for (const item of await app.gbrain.listPages(projectPrefix(project.id))) {
      const target = parseSlug(item.slug, project.id);
      if (!target) continue;
      const stored = app.store.getMemory(target.key);
      if (stored && (stored.gbrainSlug !== item.slug || stored.gbrainUpdatedAt === item.updatedAt)) continue;
      const page = await app.gbrain.getPage(item.slug);
      if (page) reconcile(target, stored, page, item.updatedAt);
    }
  }

  function reject(actor: SessionRow | null, current: StoredMemory, expected: number | undefined): PublishResult {
    app.store.addActivity({
      type: 'publish_rejected',
      actorSessionId: actor?.id ?? null,
      taskId: actor?.taskId ?? null,
      subject: current.key,
      data: {expected: expected ?? null, current: current.version},
    });
    app.bus.touch();
    return {status: 'version_conflict', entry: toEntry(current)};
  }

  async function publish(actor: SessionRow | null, input: PublishInput): Promise<PublishResult> {
    const project = requireProject();
    const key = normalizeKey(input.key);
    const title = input.title.trim();
    const body = normalizeBody(input.body);
    if (!title || !body) throw new Error('title and body must not be empty');

    const stored = app.store.getMemory(key);
    if (stored) {
      if (input.expectedVersion !== stored.version) return reject(actor, stored, input.expectedVersion);
      if (stored.body === body) {
        linkActor(actor, key, stored.version);
        return {status: 'unchanged', entry: toEntry(stored)};
      }
    } else if (input.expectedVersion) {
      throw new Error(`Memory "${key}" does not exist; omit expected_version to create it`);
    }

    const kind = input.kind;
    const version = (stored?.version ?? 0) + 1;
    const slug = stored?.gbrainSlug ?? `${projectPrefix(project.id)}${kind}/${key}`;
    const put = await app.gbrain.putPage(slug, renderPage(project.id, kind, key, title, version, body), stored?.gbrainRevision);

    if (put.status === 'conflict') {
      // GBrain moved underneath the mirror. Absorb that now so the returned version is one the agent can publish against.
      const page = await app.gbrain.getPage(slug);
      const current = page ? reconcile({key, kind: stored?.kind ?? kind, slug}, stored, page, '') : stored;
      if (!current) throw new Error(`GBrain refused to create ${slug}`);
      return reject(actor, current, input.expectedVersion);
    }

    const entry: StoredMemory = {
      key,
      kind,
      title,
      body,
      version,
      gbrainSlug: slug,
      authorSessionId: actor?.id ?? null,
      updatedAt: Date.now(),
      gbrainRevision: put.revision,
      // The next watch tick fills this in from list_pages.
      gbrainUpdatedAt: '',
    };
    recordVersion(entry, stored ? toVersion(stored) : null, actor);
    return {status: stored ? 'updated' : 'created', entry: toEntry(entry)};
  }

  async function get(actor: SessionRow | null, rawKey: string): Promise<MemoryRead | null> {
    const key = normalizeKey(rawKey);
    let stored = app.store.getMemory(key);
    if (!stored) {
      await syncPages();
      stored = app.store.getMemory(key);
      if (!stored) return null;
    }

    const page = await app.gbrain.getPage(stored.gbrainSlug);
    if (!page) return null;
    const target = {key, kind: stored.kind, slug: stored.gbrainSlug};
    const current = reconcile(target, stored, page, page.revision === stored.gbrainRevision ? stored.gbrainUpdatedAt : '');

    if (actor) {
      linkActor(actor, key, current.version);
      for (const impact of app.store.listOpenImpacts(actor.id, ['pending', 'delivered'])) {
        if (impact.source !== 'decision' || impact.sourceKey !== key || (impact.toVersion ?? 0) > current.version) continue;
        app.coordination.ackImpact(actor, impact.id, 'acknowledged', '');
        app.store.linkTaskDecision(impact.taskId, key, current.version);
      }
    }

    app.bus.touch();
    return {
      entry: {...toEntry(current), title: page.title || current.title, body: normalizeBody(page.body)},
      previous: current.version > 1 ? app.store.getMemoryVersion(key, current.version - 1) : null,
    };
  }

  return {
    publish: (actor, input) => locked(() => publish(actor, input)),
    get: (actor, key) => locked(() => get(actor, key)),

    async search(query) {
      const project = requireProject();
      const hits = await app.gbrain.search(query, projectPrefix(project.id), SEARCH_LIMIT);
      return hits.map(hit => ({key: parseSlug(hit.slug, project.id)?.key ?? null, title: hit.title, snippet: hit.snippet, slug: hit.slug}));
    },

    startExternalWatch() {
      if (timer) return;
      timer = setInterval(() => {
        if (ticking) return;
        ticking = true;
        locked(syncPages)
          .catch(error => console.error('memory watch failed:', error))
          .finally(() => {
            ticking = false;
          });
      }, WATCH_INTERVAL_MS);
      timer.unref();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
