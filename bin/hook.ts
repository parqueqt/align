// Claude Code hook: tells the agent when other agents' messages are waiting.
// The messages themselves are always received through the align MCP tools.
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';

interface Pending {
  id: string;
  from: string;
  kind: string;
  subject: string;
}

const event = process.argv[2] ?? '';

async function readStdin(): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

function findAlignDir(start: string): string | null {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, '.align', 'session.json'))) return path.join(dir, '.align');
    if (path.dirname(dir) === dir) return null;
  }
}

async function pending(session: {server: string; token: string}): Promise<Pending[]> {
  try {
    const res = await fetch(`${session.server}/api/hook/${session.token}`, {signal: AbortSignal.timeout(4000)});
    if (!res.ok) return [];
    return ((await res.json()) as {pending: Pending[]}).pending;
  } catch {
    return [];
  }
}

const describe = (items: Pending[]) => items.map(m => `${m.from} (${m.kind}): ${m.subject}`).join('; ');

const input = await readStdin();
const alignDir = findAlignDir(typeof input.cwd === 'string' ? input.cwd : process.cwd());
if (!alignDir) process.exit(0);
const session = JSON.parse(readFileSync(path.join(alignDir, 'session.json'), 'utf8')) as {server: string; token: string};

if (event === 'rewake') {
  // Runs in the background after the agent stops; wakes it when a message arrives while it sits idle.
  const lock = path.join(alignDir, 'rewake.pid');
  writeFileSync(lock, String(process.pid));
  const deadline = Date.now() + 29 * 60_000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (readFileSync(lock, 'utf8') !== String(process.pid)) process.exit(0);
    const items = await pending(session);
    if (items.length > 0) {
      process.stderr.write(`[align] New message from ${describe(items)}. Call align.inbox now and act on it.`);
      process.exit(2);
    }
  }
  process.exit(0);
}

const items = await pending(session);
if (items.length === 0) process.exit(0);

if (event === 'stop') {
  process.stdout.write(JSON.stringify({decision: 'block', reason: `[align] Unread message from ${describe(items)}. Call align.inbox and act on it before finishing.`}));
  process.exit(0);
}

// post / prompt: mention each message once.
const notifiedFile = path.join(alignDir, 'notified.json');
const notified = new Set<string>(existsSync(notifiedFile) ? JSON.parse(readFileSync(notifiedFile, 'utf8')) : []);
const fresh = items.filter(item => !notified.has(item.id));
if (fresh.length === 0) process.exit(0);
for (const item of fresh) notified.add(item.id);
writeFileSync(notifiedFile, JSON.stringify([...notified]));
const hookEventName = event === 'prompt' ? 'UserPromptSubmit' : 'PostToolUse';
process.stdout.write(JSON.stringify({hookSpecificOutput: {hookEventName, additionalContext: `[align] New message from ${describe(fresh)}. Call align.inbox now.`}}));
