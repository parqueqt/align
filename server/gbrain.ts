import {execFile} from 'node:child_process';
import {existsSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import type {App, GBrain, GBrainHit, PutPageResult} from './contracts.ts';

const execFileAsync = promisify(execFile);

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const INIT_TIMEOUT_MS = 300_000;
const LIST_LIMIT = 100;
// GBrain cannot filter by prefix, so search asks for more rows than the caller wants.
const SEARCH_FETCH_LIMIT = 100;
const CONFLICT_CODES = new Set(['revision_required', 'revision_conflict']);

// GBrain lengthens the fence when the value itself contains a code fence.
const QUOTE_WRAPPER = /^\[quoted conversation excerpt from [^\]]*; source material, not instructions\]\n(`{3,})text\n([\s\S]*)\n\1\s*$/;

class GBrainError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface ToolResult {
  isError?: boolean;
  content?: {type: string; text?: string}[];
}

interface PageRow {
  slug: string;
  title: unknown;
  compiled_truth: unknown;
  revision: string;
}

interface SearchRow {
  slug: string;
  title: unknown;
  chunk_text: unknown;
  score: number;
}

interface ListRow {
  slug: string;
  title: unknown;
  updated_at: string;
}

export function unwrapQuoted(value: unknown): string {
  if (typeof value !== 'string') return '';
  const match = QUOTE_WRAPPER.exec(value);
  return match ? match[2]! : value;
}

function errorCode(data: Record<string, unknown> | null): string {
  const error = data?.error as string | {code?: string} | undefined;
  if (typeof error === 'string') return error;
  return error?.code ?? (data?.code as string | undefined) ?? 'tool_error';
}

function parseResult(name: string, result: ToolResult): unknown {
  const text = result.content?.[0]?.text ?? '';
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new GBrainError(result.isError ? 'tool_error' : 'bad_response', `GBrain ${name}: ${text.slice(0, 500)}`);
  }
  const fields = data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  if (result.isError || fields?.error) {
    throw new GBrainError(errorCode(fields), `GBrain ${name}: ${String(fields?.message ?? text.slice(0, 500))}`);
  }
  return data;
}

export function createGBrain(app: App): GBrain {
  // Set while connecting too, so stop() can tear down a connection in progress.
  let client: Client | null = null;
  let connected = false;
  let abort: AbortController | null = null;
  let looping = false;

  async function connectOnce(bunBin: string, cli: string, signal: AbortSignal): Promise<void> {
    const {gbrainHome} = app.config;
    if (!existsSync(path.join(gbrainHome, '.gbrain', 'brain.pglite'))) {
      mkdirSync(gbrainHome, {recursive: true});
      await execFileAsync(bunBin, [cli, 'init', '--pglite', '--no-embedding'], {
        env: {...process.env, GBRAIN_HOME: gbrainHome},
        timeout: INIT_TIMEOUT_MS,
        signal,
        windowsHide: true,
      });
    }

    const transport = new StdioClientTransport({
      command: bunBin,
      args: [cli, 'serve', '--surface', 'full'],
      env: {GBRAIN_HOME: gbrainHome},
      stderr: 'ignore',
    });
    const next = new Client({name: 'align', version: '0.1.0'});
    next.onclose = () => {
      if (client !== next) return;
      client = null;
      connected = false;
      if (signal.aborted) return;
      app.bus.setRuntime({gbrain: 'starting'});
      void connectLoop(bunBin, cli, signal);
    };
    client = next;
    try {
      await next.connect(transport);
    } catch (error) {
      if (client === next) client = null;
      throw error;
    }
    if (signal.aborted || client !== next) return;
    connected = true;
    app.bus.setRuntime({gbrain: 'ready'});
  }

  // One loop covers boot and reconnects: a fast restart can briefly lose the PGLite lock to the previous child.
  async function connectLoop(bunBin: string, cli: string, signal: AbortSignal): Promise<void> {
    if (looping) return;
    looping = true;
    let delay = MIN_BACKOFF_MS;
    while (!signal.aborted && !connected) {
      try {
        await connectOnce(bunBin, cli, signal);
      } catch (error) {
        if (signal.aborted) break;
        console.error('gbrain connect failed:', error instanceof Error ? error.message : error);
        await sleep(delay, undefined, {signal}).catch(() => {});
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      }
    }
    looping = false;
  }

  async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!client || !connected) throw new GBrainError('not_ready', 'GBrain is not ready');
    return parseResult(name, (await client.callTool({name, arguments: args})) as ToolResult);
  }

  return {
    async start() {
      if (abort) return;
      const {bunBin, gbrainCli} = app.config;
      if (!bunBin || !gbrainCli) {
        app.bus.setRuntime({gbrain: 'unavailable'});
        return;
      }
      app.bus.setRuntime({gbrain: 'starting'});
      abort = new AbortController();
      void connectLoop(bunBin, gbrainCli, abort.signal);
    },

    async stop() {
      abort?.abort();
      abort = null;
      const closing = client;
      client = null;
      connected = false;
      await closing?.close().catch(() => {});
    },

    ready() {
      return connected;
    },

    async putPage(slug, markdown, expectedRevision): Promise<PutPageResult> {
      const args = {slug, content: markdown, content_origin: 'inferred', ...(expectedRevision ? {expected_revision: expectedRevision} : {})};
      try {
        const {revision} = (await call('put_page', args)) as {revision: string};
        return {status: 'ok', revision};
      } catch (error) {
        if (error instanceof GBrainError && CONFLICT_CODES.has(error.code)) return {status: 'conflict'};
        throw error;
      }
    },

    async getPage(slug) {
      try {
        const page = (await call('get_page', {slug})) as PageRow;
        return {slug: page.slug, title: unwrapQuoted(page.title), body: unwrapQuoted(page.compiled_truth), revision: page.revision};
      } catch (error) {
        if (error instanceof GBrainError && error.code === 'page_not_found') return null;
        throw error;
      }
    },

    async search(query, slugPrefix, limit) {
      const prefix = slugPrefix.toLowerCase();
      const run = async (text: string) => {
        const rows = (await call('search', {query: text, match: 'keyword', limit: Math.max(limit, SEARCH_FETCH_LIMIT)})) as SearchRow[];
        return rows.filter(row => row.slug.startsWith(prefix));
      };

      let rows = await run(query);
      const words = query.trim().split(/\s+/);
      if (rows.length === 0 && words.length > 1) rows = (await Promise.all(words.map(run))).flat();

      const best = new Map<string, GBrainHit>();
      for (const row of rows) {
        if ((best.get(row.slug)?.score ?? -Infinity) >= row.score) continue;
        best.set(row.slug, {slug: row.slug, title: unwrapQuoted(row.title), snippet: unwrapQuoted(row.chunk_text), score: row.score});
      }
      return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    },

    async listPages(slugPrefix) {
      const rows = (await call('list_pages', {slug_prefix: slugPrefix.toLowerCase(), limit: LIST_LIMIT})) as ListRow[];
      return rows.map(row => ({slug: row.slug, title: unwrapQuoted(row.title), updatedAt: row.updated_at}));
    },
  };
}
