import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import type {IncomingMessage, Server, ServerResponse} from 'node:http';
import path from 'node:path';
import {WebSocketServer} from 'ws';
import {handleMcp} from './mcp.ts';
import type {App} from './contracts.ts';
import type {ApiError} from '../shared/types.ts';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_DEVELOPER_NAME_LENGTH = 64;
const DIST_DIR = path.resolve(import.meta.dirname, '..', 'dist');
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1']);
const VITE_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
const SESSION_ROUTE = /^\/api\/sessions\/([^/]+)\/(prompt|interrupt|items)$/;
const MCP_ROUTE = /^\/mcp\/([^/]+)$/;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The server can launch agents that write code, so cross-site requests and DNS rebinding must fail. */
function isTrustedRequest(req: IncomingMessage): boolean {
  const hostname = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  if (!LOCAL_HOSTNAMES.has(hostname)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const port = req.socket.localPort;
  return VITE_ORIGINS.has(origin) || origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`;
}

function parseUrl(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
  res.end(JSON.stringify(body));
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

function sendError(res: ServerResponse, error: unknown): void {
  const status = error instanceof HttpError ? error.status : 500;
  if (status === 500) console.error(error);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  // An oversized body is left unread, so the connection cannot be reused.
  if (status === 413) res.setHeader('connection', 'close');
  const body: ApiError = {error: error instanceof Error ? error.message : String(error)};
  sendJson(res, status, body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.off('data', onData);
        req.resume();
        reject(new HttpError(413, 'body too large'));
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let parsed: unknown;
  const raw = await readBody(req);
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HttpError(400, 'expected a JSON object');
  return parsed as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, `${key} is required`);
  return value;
}

function requireOwner(app: App, sessionId: string, developerId: string): void {
  const session = app.store.getSession(sessionId);
  if (!session) throw new HttpError(404, 'session not found');
  if (session.developerId !== developerId) throw new HttpError(403, 'not your session');
}

async function setProject(app: App, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const repoPath = requiredString(await readJson(req), 'repoPath');
  let repo;
  try {
    repo = await app.git.inspectRepo(repoPath);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  }
  if (app.store.listSessions().length > 0) throw new HttpError(409, 'sessions already exist');
  const project = app.store.setProject({name: repo.name, repoPath: repo.root, baseBranch: repo.baseBranch});
  app.bus.touch();
  sendJson(res, 200, project);
}

async function createDeveloper(app: App, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const name = requiredString(await readJson(req), 'name').trim();
  if (name.length > MAX_DEVELOPER_NAME_LENGTH) throw new HttpError(400, 'name is too long');
  const developer = app.store.upsertDeveloper(name);
  app.bus.touch();
  sendJson(res, 200, developer);
}

async function createSession(app: App, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const developerId = requiredString(body, 'developerId');
  const prompt = requiredString(body, 'prompt');
  const agent = body.agent;
  if (agent !== 'claude' && agent !== 'codex') throw new HttpError(400, 'agent must be claude or codex');
  if (!app.store.getProject()) throw new HttpError(409, 'no project');
  if (!app.store.getDeveloper(developerId)) throw new HttpError(400, 'unknown developer');
  sendJson(res, 200, await app.sessions.create({developerId, agent, prompt}));
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  let relative: string;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'invalid path');
  }
  const requested = path.resolve(DIST_DIR, `.${relative}`);
  if (!requested.startsWith(DIST_DIR + path.sep) && requested !== DIST_DIR) throw new HttpError(404, 'not found');

  let file = requested;
  let content = await readFile(file).catch(() => null);
  if (content === null && path.extname(requested) === '') {
    file = path.join(DIST_DIR, 'index.html');
    content = await readFile(file).catch(() => null);
  }
  if (content === null) throw new HttpError(404, 'not found');

  res.writeHead(200, {
    'content-type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : content);
}

async function handleRequest(app: App, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isTrustedRequest(req)) throw new HttpError(403, 'forbidden');
  const url = parseUrl(req);
  if (!url) throw new HttpError(400, 'invalid url');
  const {pathname} = url;
  const method = req.method;

  const mcp = MCP_ROUTE.exec(pathname);
  if (mcp) {
    const token = mcp[1]!;
    if (!app.store.getSessionByToken(token)) throw new HttpError(404, 'not found');
    await handleMcp(app, token, req, res);
    return;
  }

  if (method === 'GET' && pathname === '/api/state') return sendJson(res, 200, app.bus.snapshot());
  if (method === 'POST' && pathname === '/api/project') return setProject(app, req, res);
  if (method === 'POST' && pathname === '/api/developers') return createDeveloper(app, req, res);
  if (method === 'POST' && pathname === '/api/sessions') return createSession(app, req, res);

  const sessionRoute = SESSION_ROUTE.exec(pathname);
  if (sessionRoute) {
    const sessionId = sessionRoute[1]!;
    const action = sessionRoute[2];
    if (method === 'GET' && action === 'items') {
      if (!app.store.getSession(sessionId)) throw new HttpError(404, 'session not found');
      return sendJson(res, 200, app.store.listItems(sessionId));
    }
    if (method === 'POST' && action === 'prompt') {
      const body = await readJson(req);
      const developerId = requiredString(body, 'developerId');
      const text = requiredString(body, 'text');
      requireOwner(app, sessionId, developerId);
      await app.sessions.prompt(sessionId, developerId, text);
      return sendNoContent(res);
    }
    if (method === 'POST' && action === 'interrupt') {
      const developerId = requiredString(await readJson(req), 'developerId');
      requireOwner(app, sessionId, developerId);
      app.sessions.interrupt(sessionId);
      return sendNoContent(res);
    }
  }

  const isApi = pathname.startsWith('/api/') || pathname === '/api' || pathname === '/ws' || pathname.startsWith('/mcp/');
  if (!isApi && (method === 'GET' || method === 'HEAD')) return serveStatic(req, res, pathname);
  throw new HttpError(404, 'not found');
}

export function createHttpServer(app: App): Server {
  const sockets = new WebSocketServer({noServer: true, maxPayload: 4096});

  const server = createServer((req, res) => {
    handleRequest(app, req, res).catch((error: unknown) => sendError(res, error));
  });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    if (!isTrustedRequest(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const url = parseUrl(req);
    if (url?.pathname !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => {});
      const disconnect = app.bus.connect(url.searchParams.get('dev'), (event) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
      });
      ws.on('close', disconnect);
    });
  });

  return server;
}
