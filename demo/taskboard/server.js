import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {listTasks} from './store.js';

const PUBLIC = path.join(import.meta.dirname, 'public');
const TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css'};

export function json(res, status, body) {
  res.writeHead(status, {'content-type': 'application/json'});
  res.end(JSON.stringify(body));
}

export async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/api/tasks') return json(res, 200, listTasks());

    // TODO(backend): task update endpoint.

    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
      if (!file.startsWith(PUBLIC)) return json(res, 404, {error: 'not found'});
      const body = await readFile(file).catch(() => null);
      if (!body) return json(res, 404, {error: 'not found'});
      res.writeHead(200, {'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream'});
      return res.end(body);
    }
    json(res, 404, {error: 'not found'});
  } catch (error) {
    json(res, 500, {error: String(error)});
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(import.meta.dirname, 'server.js')) {
  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => console.log(`taskboard on http://localhost:${port}`));
}
