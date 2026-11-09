import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import type {SQLInputValue, StatementSync} from 'node:sqlite';
import type {Config, NewActivity, NewImpact, NewItem, NewMessage, NewSession, NewTask, SessionRow, Store, StoredMemory} from './contracts.ts';
import type {Activity, AgentMessage, ChatItem, Developer, FileChange, Impact, ImpactState, MemoryEntry, MemoryVersion, Project, Task} from '../shared/types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS counters (prefix TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL, base_branch TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS developers (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, color TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reserved_handles (handle TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  mcp_token TEXT NOT NULL UNIQUE,
  handle TEXT NOT NULL UNIQUE,
  developer_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  status_detail TEXT,
  task_id TEXT,
  branch TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT,
  native_session_id TEXT,
  auto_turns INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  runner_pid INTEGER
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  tool TEXT,
  developer_id TEXT,
  message_ids TEXT NOT NULL,
  task_id TEXT,
  streaming INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS items_by_session ON items (session_id, seq);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT NOT NULL,
  session_id TEXT NOT NULL,
  files TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_deps (task_id TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY (task_id, depends_on));
CREATE TABLE IF NOT EXISTS task_decisions (task_id TEXT NOT NULL, decision_key TEXT NOT NULL, acked_version INTEGER NOT NULL, PRIMARY KEY (task_id, decision_key));
CREATE TABLE IF NOT EXISTS memory (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  version INTEGER NOT NULL,
  gbrain_slug TEXT NOT NULL,
  author_session_id TEXT,
  updated_at INTEGER NOT NULL,
  gbrain_revision TEXT NOT NULL,
  gbrain_updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_versions (
  key TEXT NOT NULL,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author_session_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (key, version)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_session_id TEXT,
  to_session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  reply_to_id TEXT,
  task_id TEXT,
  decision_key TEXT,
  impact_id TEXT,
  requires_action INTEGER NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  read_at INTEGER,
  processed_at INTEGER
);
CREATE INDEX IF NOT EXISTS messages_by_recipient ON messages (to_session_id, state);
CREATE TABLE IF NOT EXISTS impacts (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_key TEXT NOT NULL,
  from_version INTEGER,
  to_version INTEGER,
  actor_session_id TEXT,
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT,
  state TEXT NOT NULL,
  note TEXT NOT NULL,
  commit_sha TEXT,
  reminders INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  acknowledged_at INTEGER,
  resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS files (
  session_id TEXT NOT NULL,
  path TEXT NOT NULL,
  state TEXT NOT NULL,
  additions INTEGER NOT NULL,
  deletions INTEGER NOT NULL,
  committed INTEGER NOT NULL,
  PRIMARY KEY (session_id, path)
);
CREATE TABLE IF NOT EXISTS overlaps_seen (path TEXT NOT NULL, a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY (path, a, b));
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  actor_session_id TEXT,
  target_session_id TEXT,
  task_id TEXT,
  subject TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

// Hues stay clear of the agent marks (Claude orange, Codex near-black).
const PALETTE = ['#3E63DD', '#12A594', '#D6409F', '#8E4EC6', '#0090FF', '#30A46C', '#E5484D', '#AD7F58'];
const OPEN_IMPACT_STATES: ImpactState[] = ['pending', 'delivered', 'acknowledged'];
const MAX_HANDLE_NAME_LENGTH = 24;

const SESSION_COLUMNS = {
  mcpToken: 'mcp_token',
  handle: 'handle',
  developerId: 'developer_id',
  agent: 'agent',
  title: 'title',
  status: 'status',
  statusDetail: 'status_detail',
  taskId: 'task_id',
  branch: 'branch',
  worktreePath: 'worktree_path',
  baseSha: 'base_sha',
  headSha: 'head_sha',
  nativeSessionId: 'native_session_id',
  autoTurns: 'auto_turns',
  createdAt: 'created_at',
  lastActiveAt: 'last_active_at',
  runnerPid: 'runner_pid',
};
const ITEM_COLUMNS = {text: 'text', tool: 'tool', streaming: 'streaming'};
const TASK_COLUMNS = {title: 'title', description: 'description', status: 'status', note: 'note', files: 'files', updatedAt: 'updated_at'};
const MESSAGE_COLUMNS = {state: 'state', deliveredAt: 'delivered_at', readAt: 'read_at', processedAt: 'processed_at'};
const IMPACT_COLUMNS = {
  toVersion: 'to_version',
  state: 'state',
  note: 'note',
  commitSha: 'commit_sha',
  reminders: 'reminders',
  messageId: 'message_id',
  createdAt: 'created_at',
  deliveredAt: 'delivered_at',
  acknowledgedAt: 'acknowledged_at',
  resolvedAt: 'resolved_at',
};

const TASK_SELECT = `
SELECT t.*, s.developer_id, s.agent, s.branch, s.worktree_path,
  (SELECT json_group_array(depends_on) FROM task_deps WHERE task_id = t.id) AS depends_on_json,
  (SELECT json_group_array(json_object('key', decision_key, 'ackedVersion', acked_version)) FROM task_decisions WHERE task_id = t.id) AS decisions_json
FROM tasks t JOIN sessions s ON s.id = t.session_id`;

type Row = Record<string, any>;

function toSql(value: unknown): SQLInputValue {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return value as SQLInputValue;
}

function found<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`${what} not found`);
  return value;
}

function handleName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_HANDLE_NAME_LENGTH)
    .replace(/^-+|-+$/g, '');
}

function toDeveloper(r: Row): Omit<Developer, 'online'> {
  return {id: r.id, name: r.name, color: r.color};
}

function toSession(r: Row): SessionRow {
  return {
    id: r.id,
    mcpToken: r.mcp_token,
    handle: r.handle,
    developerId: r.developer_id,
    agent: r.agent,
    title: r.title,
    status: r.status,
    statusDetail: r.status_detail,
    taskId: r.task_id,
    branch: r.branch,
    worktreePath: r.worktree_path,
    baseSha: r.base_sha,
    headSha: r.head_sha,
    nativeSessionId: r.native_session_id,
    autoTurns: r.auto_turns,
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
    runnerPid: r.runner_pid,
  };
}

function toItem(r: Row): ChatItem {
  return {
    id: r.id,
    sessionId: r.session_id,
    seq: r.seq,
    kind: r.kind,
    text: r.text,
    tool: r.tool === null ? null : JSON.parse(r.tool),
    developerId: r.developer_id,
    messageIds: JSON.parse(r.message_ids),
    taskId: r.task_id,
    streaming: r.streaming === 1,
    createdAt: r.created_at,
  };
}

function toTask(r: Row): Task {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status,
    note: r.note,
    sessionId: r.session_id,
    developerId: r.developer_id,
    agent: r.agent,
    branch: r.branch,
    worktreePath: r.worktree_path,
    files: JSON.parse(r.files),
    dependsOn: JSON.parse(r.depends_on_json),
    decisions: JSON.parse(r.decisions_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toMemory(r: Row): MemoryEntry {
  return {
    key: r.key,
    kind: r.kind,
    title: r.title,
    body: r.body,
    version: r.version,
    gbrainSlug: r.gbrain_slug,
    authorSessionId: r.author_session_id,
    updatedAt: r.updated_at,
  };
}

function toMemoryVersion(r: Row): MemoryVersion {
  return {key: r.key, version: r.version, title: r.title, body: r.body, authorSessionId: r.author_session_id, createdAt: r.created_at};
}

function toMessage(r: Row): AgentMessage {
  return {
    id: r.id,
    fromSessionId: r.from_session_id,
    toSessionId: r.to_session_id,
    kind: r.kind,
    subject: r.subject,
    body: r.body,
    replyToId: r.reply_to_id,
    taskId: r.task_id,
    decisionKey: r.decision_key,
    impactId: r.impact_id,
    requiresAction: r.requires_action === 1,
    state: r.state,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at,
    readAt: r.read_at,
    processedAt: r.processed_at,
  };
}

function toImpact(r: Row): Impact {
  return {
    id: r.id,
    source: r.source,
    sourceKey: r.source_key,
    fromVersion: r.from_version,
    toVersion: r.to_version,
    actorSessionId: r.actor_session_id,
    taskId: r.task_id,
    sessionId: r.session_id,
    messageId: r.message_id,
    state: r.state,
    note: r.note,
    commitSha: r.commit_sha,
    reminders: r.reminders,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at,
    acknowledgedAt: r.acknowledged_at,
    resolvedAt: r.resolved_at,
  };
}

function toFile(r: Row): FileChange {
  return {sessionId: r.session_id, path: r.path, state: r.state, additions: r.additions, deletions: r.deletions, committed: r.committed === 1};
}

function toActivity(r: Row): Activity {
  return {
    id: r.id,
    type: r.type,
    actorSessionId: r.actor_session_id,
    targetSessionId: r.target_session_id,
    taskId: r.task_id,
    subject: r.subject,
    data: JSON.parse(r.data),
    createdAt: r.created_at,
  };
}

/** `close` is an addition to the Store contract: open database files cannot be deleted on Windows. */
export function createStore(config: Config): Store & {close(): void} {
  const db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const statements = new Map<string, StatementSync>();

  function prepare(sql: string): StatementSync {
    let statement = statements.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  }

  function one(sql: string, ...params: SQLInputValue[]): Row | null {
    return (prepare(sql).get(...params) as Row | undefined) ?? null;
  }

  function all(sql: string, ...params: SQLInputValue[]): Row[] {
    return prepare(sql).all(...params) as Row[];
  }

  function run(sql: string, ...params: SQLInputValue[]): number {
    return Number(prepare(sql).run(...params).changes);
  }

  function transaction<T>(body: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = body();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function nextNumber(prefix: string): number {
    const row = one('INSERT INTO counters (prefix, value) VALUES (?, 1) ON CONFLICT (prefix) DO UPDATE SET value = value + 1 RETURNING value', prefix);
    return row!.value as number;
  }

  function nextId(prefix: string): string {
    return `${prefix}${nextNumber(prefix)}`;
  }

  /** Column names come from the fixed maps above; undefined keys are skipped and null clears a column. */
  function applyPatch(table: string, columns: Record<string, string>, id: string, patch: object): void {
    const assignments: string[] = [];
    const values: SQLInputValue[] = [];
    for (const [key, column] of Object.entries(columns)) {
      const value = (patch as Record<string, unknown>)[key];
      if (value === undefined) continue;
      assignments.push(`${column} = ?`);
      values.push(toSql(value));
    }
    if (assignments.length > 0) run(`UPDATE ${table} SET ${assignments.join(', ')} WHERE id = ?`, ...values, id);
  }

  function newestFirst(table: string, limit: number | undefined): Row[] {
    const sql = `SELECT * FROM ${table} ORDER BY created_at DESC, rowid DESC`;
    return limit === undefined ? all(sql) : all(`${sql} LIMIT ?`, limit);
  }

  function placeholders(values: unknown[]): string {
    return values.map(() => '?').join(', ');
  }

  function getProject(): Project | null {
    const r = one('SELECT * FROM project');
    return r && {id: r.id, name: r.name, repoPath: r.repo_path, baseBranch: r.base_branch};
  }

  function getDeveloper(id: string): Developer | null {
    const r = one('SELECT * FROM developers WHERE id = ?', id);
    return r && {...toDeveloper(r), online: false};
  }

  function getSession(id: string): SessionRow | null {
    const r = one('SELECT * FROM sessions WHERE id = ?', id);
    return r && toSession(r);
  }

  function getItem(id: string): ChatItem | null {
    const r = one('SELECT * FROM items WHERE id = ?', id);
    return r && toItem(r);
  }

  function getTask(id: string): Task | null {
    const r = one(`${TASK_SELECT} WHERE t.id = ?`, id);
    return r && toTask(r);
  }

  function getMessage(id: string): AgentMessage | null {
    const r = one('SELECT * FROM messages WHERE id = ?', id);
    return r && toMessage(r);
  }

  function getImpact(id: string): Impact | null {
    const r = one('SELECT * FROM impacts WHERE id = ?', id);
    return r && toImpact(r);
  }

  return {
    close() {
      statements.clear();
      db.close();
    },

    getProject,

    setProject(p) {
      return transaction(() => {
        const current = getProject();
        const id = current && current.repoPath === p.repoPath ? current.id : nextId('p');
        // The memory mirror belongs to one project id.
        if (current && current.id !== id) {
          run('DELETE FROM memory');
          run('DELETE FROM memory_versions');
        }
        run('DELETE FROM project');
        run('INSERT INTO project (id, name, repo_path, base_branch) VALUES (?, ?, ?, ?)', id, p.name, p.repoPath, p.baseBranch);
        return {id, name: p.name, repoPath: p.repoPath, baseBranch: p.baseBranch};
      });
    },

    upsertDeveloper(name) {
      const clean = name.trim();
      const nameKey = clean.toLowerCase();
      const existing = one('SELECT * FROM developers WHERE name_key = ?', nameKey);
      if (existing) return {...toDeveloper(existing), online: false};
      const number = nextNumber('D');
      const developer = {id: `D${number}`, name: clean, color: PALETTE[(number - 1) % PALETTE.length]!};
      run('INSERT INTO developers (id, name, name_key, color) VALUES (?, ?, ?, ?)', developer.id, developer.name, nameKey, developer.color);
      return {...developer, online: false};
    },

    getDeveloper,

    listDevelopers() {
      return all('SELECT * FROM developers ORDER BY rowid').map(toDeveloper);
    },

    allocateHandle(developerId, agent) {
      const developer = found(getDeveloper(developerId), `developer ${developerId}`);
      const name = handleName(developer.name);
      const base = `${/[a-z]/.test(name) ? name : developerId.toLowerCase()}-${agent}`;
      for (let attempt = 1; ; attempt++) {
        const handle = attempt === 1 ? base : `${base}-${attempt}`;
        const taken = one('SELECT 1 FROM sessions WHERE handle = ? UNION ALL SELECT 1 FROM reserved_handles WHERE handle = ?', handle, handle);
        if (!taken) {
          run('INSERT INTO reserved_handles (handle) VALUES (?)', handle);
          return handle;
        }
      }
    },

    createSession(input: NewSession) {
      return transaction(() => {
        const id = nextId('S');
        const now = Date.now();
        run(
          `INSERT INTO sessions (id, mcp_token, handle, developer_id, agent, title, status, branch, worktree_path, base_sha, auto_turns, created_at, last_active_at)
           VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, 0, ?, ?)`,
          id,
          input.mcpToken,
          input.handle,
          input.developerId,
          input.agent,
          input.title,
          input.branch,
          input.worktreePath,
          input.baseSha,
          now,
          now,
        );
        run('DELETE FROM reserved_handles WHERE handle = ?', input.handle);
        return found(getSession(id), `session ${id}`);
      });
    },

    getSession,

    getSessionByToken(token) {
      const r = one('SELECT * FROM sessions WHERE mcp_token = ?', token);
      return r && toSession(r);
    },

    resolveSession(ref) {
      const r = one('SELECT * FROM sessions WHERE id = ? OR handle = ?', ref, ref);
      return r && toSession(r);
    },

    listSessions() {
      return all('SELECT * FROM sessions ORDER BY rowid').map(toSession);
    },

    updateSession(id, patch) {
      applyPatch('sessions', SESSION_COLUMNS, id, patch);
      return found(getSession(id), `session ${id}`);
    },

    addItem(input: NewItem) {
      const id = input.id ?? randomUUID();
      const taskId = input.taskId !== undefined ? input.taskId : (getSession(input.sessionId)?.taskId ?? null);
      const seq = one('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM items WHERE session_id = ?', input.sessionId)!.seq as number;
      run(
        `INSERT INTO items (id, session_id, seq, kind, text, tool, developer_id, message_ids, task_id, streaming, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.sessionId,
        seq,
        input.kind,
        input.text,
        toSql(input.tool ?? null),
        input.developerId ?? null,
        toSql(input.messageIds ?? []),
        taskId,
        toSql(input.streaming ?? false),
        Date.now(),
      );
      return found(getItem(id), `item ${id}`);
    },

    updateItem(id, patch) {
      applyPatch('items', ITEM_COLUMNS, id, patch);
      return found(getItem(id), `item ${id}`);
    },

    getItem,

    listItems(sessionId) {
      return all('SELECT * FROM items WHERE session_id = ? ORDER BY seq', sessionId).map(toItem);
    },

    closeOpenItems() {
      transaction(() => {
        run(`UPDATE items SET tool = json_set(tool, '$.status', 'error') WHERE json_extract(tool, '$.status') = 'running'`);
        run('UPDATE items SET streaming = 0 WHERE streaming = 1');
      });
    },

    createTask(input: NewTask) {
      found(getSession(input.sessionId), `session ${input.sessionId}`);
      const id = nextId('T');
      const now = Date.now();
      run(
        `INSERT INTO tasks (id, title, description, status, note, session_id, files, created_at, updated_at) VALUES (?, ?, ?, ?, '', ?, '[]', ?, ?)`,
        id,
        input.title,
        input.description,
        input.status,
        input.sessionId,
        now,
        now,
      );
      return found(getTask(id), `task ${id}`);
    },

    getTask,

    listTasks() {
      return all(`${TASK_SELECT} ORDER BY t.rowid`).map(toTask);
    },

    updateTask(id, patch) {
      applyPatch('tasks', TASK_COLUMNS, id, {...patch, updatedAt: Date.now()});
      return found(getTask(id), `task ${id}`);
    },

    addTaskDependency(taskId, dependsOnTaskId) {
      run('INSERT OR IGNORE INTO task_deps (task_id, depends_on) VALUES (?, ?)', taskId, dependsOnTaskId);
    },

    listDependents(taskId) {
      return all(`${TASK_SELECT} WHERE t.id IN (SELECT task_id FROM task_deps WHERE depends_on = ?) ORDER BY t.rowid`, taskId).map(toTask);
    },

    linkTaskDecision(taskId, key, ackedVersion) {
      run(
        `INSERT INTO task_decisions (task_id, decision_key, acked_version) VALUES (?, ?, ?)
         ON CONFLICT (task_id, decision_key) DO UPDATE SET acked_version = MAX(acked_version, excluded.acked_version)`,
        taskId,
        key,
        ackedVersion,
      );
    },

    listTasksUsingDecision(key) {
      return all(`${TASK_SELECT} WHERE t.id IN (SELECT task_id FROM task_decisions WHERE decision_key = ?) ORDER BY t.rowid`, key).map(toTask);
    },

    getMemory(key) {
      const r = one('SELECT * FROM memory WHERE key = ?', key);
      return r && {...toMemory(r), gbrainRevision: r.gbrain_revision, gbrainUpdatedAt: r.gbrain_updated_at};
    },

    listMemory() {
      return all('SELECT * FROM memory ORDER BY updated_at DESC, rowid DESC').map(toMemory);
    },

    upsertMemory(entry: StoredMemory) {
      run(
        `INSERT INTO memory (key, kind, title, body, version, gbrain_slug, author_session_id, updated_at, gbrain_revision, gbrain_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET
           kind = excluded.kind, title = excluded.title, body = excluded.body, version = excluded.version,
           gbrain_slug = excluded.gbrain_slug, author_session_id = excluded.author_session_id, updated_at = excluded.updated_at,
           gbrain_revision = excluded.gbrain_revision, gbrain_updated_at = excluded.gbrain_updated_at`,
        entry.key,
        entry.kind,
        entry.title,
        entry.body,
        entry.version,
        entry.gbrainSlug,
        entry.authorSessionId,
        entry.updatedAt,
        entry.gbrainRevision,
        entry.gbrainUpdatedAt,
      );
    },

    setMemorySync(key, gbrainRevision, gbrainUpdatedAt) {
      run('UPDATE memory SET gbrain_revision = ?, gbrain_updated_at = ? WHERE key = ?', gbrainRevision, gbrainUpdatedAt, key);
    },

    addMemoryVersion(v) {
      run(
        'INSERT OR REPLACE INTO memory_versions (key, version, title, body, author_session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        v.key,
        v.version,
        v.title,
        v.body,
        v.authorSessionId,
        v.createdAt,
      );
    },

    getMemoryVersion(key, version) {
      const r = one('SELECT * FROM memory_versions WHERE key = ? AND version = ?', key, version);
      return r && toMemoryVersion(r);
    },

    createMessage(input: NewMessage) {
      const id = nextId('M');
      run(
        `INSERT INTO messages (id, from_session_id, to_session_id, kind, subject, body, reply_to_id, task_id, decision_key, impact_id, requires_action, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
        id,
        input.fromSessionId,
        input.toSessionId,
        input.kind,
        input.subject,
        input.body,
        input.replyToId ?? null,
        input.taskId ?? null,
        input.decisionKey ?? null,
        input.impactId ?? null,
        toSql(input.requiresAction),
        Date.now(),
      );
      return found(getMessage(id), `message ${id}`);
    },

    getMessage,

    updateMessage(id, patch) {
      applyPatch('messages', MESSAGE_COLUMNS, id, patch);
      return found(getMessage(id), `message ${id}`);
    },

    listMessages(limit) {
      return newestFirst('messages', limit).map(toMessage);
    },

    listMessagesForSession(sessionId, states) {
      const filter = states ? ` AND state IN (${placeholders(states)})` : '';
      return all(`SELECT * FROM messages WHERE to_session_id = ?${filter} ORDER BY created_at, rowid`, sessionId, ...(states ?? [])).map(toMessage);
    },

    createImpact(input: NewImpact) {
      const id = nextId('I');
      run(
        `INSERT INTO impacts (id, source, source_key, from_version, to_version, actor_session_id, task_id, session_id, state, note, reminders, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', 0, ?)`,
        id,
        input.source,
        input.sourceKey,
        input.fromVersion,
        input.toVersion,
        input.actorSessionId,
        input.taskId,
        input.sessionId,
        Date.now(),
      );
      return found(getImpact(id), `impact ${id}`);
    },

    getImpact,

    updateImpact(id, patch) {
      applyPatch('impacts', IMPACT_COLUMNS, id, patch);
      return found(getImpact(id), `impact ${id}`);
    },

    listImpacts(limit) {
      return newestFirst('impacts', limit).map(toImpact);
    },

    listOpenImpacts(sessionId, states = OPEN_IMPACT_STATES) {
      return all(`SELECT * FROM impacts WHERE session_id = ? AND state IN (${placeholders(states)}) ORDER BY created_at, rowid`, sessionId, ...states).map(toImpact);
    },

    findOpenImpact(taskId, source, sourceKey) {
      const r = one(
        `SELECT * FROM impacts WHERE task_id = ? AND source = ? AND source_key = ? AND state IN (${placeholders(OPEN_IMPACT_STATES)}) ORDER BY rowid DESC LIMIT 1`,
        taskId,
        source,
        sourceKey,
        ...OPEN_IMPACT_STATES,
      );
      return r && toImpact(r);
    },

    replaceFiles(sessionId, files) {
      transaction(() => {
        run('DELETE FROM files WHERE session_id = ?', sessionId);
        for (const file of files) {
          run(
            'INSERT INTO files (session_id, path, state, additions, deletions, committed) VALUES (?, ?, ?, ?, ?, ?)',
            sessionId,
            file.path,
            file.state,
            file.additions,
            file.deletions,
            toSql(file.committed),
          );
        }
      });
    },

    listFiles() {
      return all('SELECT * FROM files ORDER BY session_id, path').map(toFile);
    },

    markOverlapSeen(path, a, b) {
      const [first, second] = a < b ? [a, b] : [b, a];
      return run('INSERT OR IGNORE INTO overlaps_seen (path, a, b) VALUES (?, ?, ?)', path, first, second) > 0;
    },

    addActivity(input: NewActivity) {
      const activity = {
        type: input.type,
        actorSessionId: input.actorSessionId ?? null,
        targetSessionId: input.targetSessionId ?? null,
        taskId: input.taskId ?? null,
        subject: input.subject ?? '',
        data: input.data ?? {},
        createdAt: Date.now(),
      };
      const result = prepare(
        'INSERT INTO activity (type, actor_session_id, target_session_id, task_id, subject, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(activity.type, activity.actorSessionId, activity.targetSessionId, activity.taskId, activity.subject, toSql(activity.data), activity.createdAt);
      return {id: Number(result.lastInsertRowid), ...activity};
    },

    listActivity(limit) {
      return newestFirst('activity', limit).map(toActivity);
    },

    latestCommitSince(sessionId, afterMs) {
      const r = one(`SELECT * FROM activity WHERE type = 'commit' AND actor_session_id = ? AND created_at > ? ORDER BY created_at DESC, id DESC LIMIT 1`, sessionId, afterMs);
      return r && toActivity(r);
    },
  };
}
