// align — CLI for the Align collaboration layer.
import {spawn, spawnSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type {Activity, Snapshot} from '../shared/types.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.ALIGN_PORT || 4600);
const SERVER = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === 'win32';

const [command = 'help', ...rest] = process.argv.slice(2);

function flags(args: string[]): {positional: string[]; opts: Record<string, string>} {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=', 2);
      opts[key!] = inline ?? (args[i + 1] && !args[i + 1]!.startsWith('--') ? args[++i]! : 'true');
    } else positional.push(arg);
  }
  return {positional, opts};
}

async function api<T>(method: string, route: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(SERVER + route, {method, headers: body ? {'content-type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined});
  } catch {
    fail(`Align is not running on ${SERVER}. Start it with: align serve`);
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) fail(json?.error ?? `HTTP ${res.status}`);
  return json as T;
}

function fail(message: string): never {
  console.error(`align: ${message}`);
  process.exit(1);
}

// ---- terminal formatting --------------------------------------------------

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint('2');
const bold = paint('1');
const orange = paint('38;5;173');
const cyan = paint('36');
const green = paint('32');
const yellow = paint('33');

const agentMark = (agent: string) => (agent === 'claude' ? orange('●') : cyan('●'));
const time = (ms: number) => new Date(ms).toTimeString().slice(0, 8);

function who(snapshot: Snapshot, sessionId: string | null): string {
  if (!sessionId) return 'align';
  const session = snapshot.sessions.find(s => s.id === sessionId);
  return session ? `${agentMark(session.agent)} ${session.handle}` : sessionId;
}

function describe(snapshot: Snapshot, a: Activity): string | null {
  const actor = who(snapshot, a.actorSessionId);
  const target = who(snapshot, a.targetSessionId);
  const data = a.data as Record<string, any>;
  const message = (id: string) => snapshot.messages.find(m => m.id === id);
  switch (a.type) {
    case 'session_started': return `${actor} joined`;
    case 'task_registered': return `${actor} task  ${a.subject}`;
    case 'task_updated': return data.status ? `${actor} task  ${a.subject} ${dim('→ ' + data.status)}` : null;
    case 'memory_published': return `${actor} ${green('gbrain publish')}  ${bold(a.subject)} v${data.to ?? 1}`;
    case 'memory_updated': return `${actor} ${green('gbrain update')}  ${bold(a.subject)} v${data.from}→v${data.to}`;
    case 'memory_read': return `${actor} ${green('gbrain read')}  ${bold(a.subject)} v${data.version}`;
    case 'publish_rejected': return `${actor} ${yellow('publish rejected')}  ${a.subject}`;
    case 'message_sent': {
      const m = message(a.subject);
      return `${actor} → ${target}  ${yellow(data.kind)}  ${m?.subject ?? data.title ?? ''}`;
    }
    case 'message_delivered': return `${target} ${dim('received')} ${a.subject}`;
    case 'message_processed': return `${actor} ${dim('answered')} ${a.subject}`;
    case 'impact_created': return `${target} ${yellow('affected by')} ${a.subject} ${dim(`v${data.from ?? 0}→v${data.to ?? ''}`)}`;
    case 'impact_resolved': return `${actor} ${green(data.outcome)}  ${a.subject}${data.commitSha ? dim(' ' + String(data.commitSha).slice(0, 7)) : ''}`;
    case 'commit': return `${actor} ${green('commit')} ${String(a.subject).slice(0, 7)}  ${dim((data.files ?? []).join(', '))}`;
    case 'overlap_detected': return `${actor} ↔ ${target}  ${yellow('same file')} ${a.subject}`;
    case 'gate_blocked': return `${actor} ${yellow('done blocked')} ${a.subject}`;
    case 'task_done': return `${actor} ${green('done')} ${a.subject}`;
    default: return null;
  }
}

function printStatus(s: Snapshot): void {
  console.log(bold(s.project ? `align · ${s.project.name}` : 'align') + dim(`  gbrain ${s.runtime.gbrain}`));
  console.log('');
  for (const session of s.sessions) {
    const task = s.tasks.find(t => t.id === session.taskId);
    const active = Date.now() - session.lastActiveAt < 180_000;
    console.log(`${agentMark(session.agent)} ${bold(session.handle)}  ${active ? green('active') : dim('idle')}  ${dim(session.branch)}`);
    if (task) console.log(`   ${task.id} ${task.title}  ${dim(task.status)}${task.note ? dim('  · ' + task.note) : ''}`);
    const files = s.files.filter(f => f.sessionId === session.id).map(f => f.path);
    if (files.length) console.log(dim(`   ${files.join('  ')}`));
  }
  if (s.memory.length) {
    console.log('');
    console.log(bold('memory'));
    for (const m of s.memory) console.log(`   ${m.key} v${m.version}  ${dim(m.title)}`);
  }
  const messages = s.messages.slice(0, 8).reverse();
  if (messages.length) {
    console.log('');
    console.log(bold('messages'));
    for (const m of messages) console.log(`   ${who(s, m.fromSessionId)} → ${who(s, m.toSessionId)}  ${yellow(m.kind)}  ${m.subject}  ${dim(m.state)}`);
  }
  if (s.issues.length) {
    console.log('');
    console.log(bold('issues'));
    for (const issue of s.issues) console.log(`   ${yellow(issue.kind)}  ${issue.subject}`);
  }
}

// ---- commands ---------------------------------------------------------------

function nodeArgs(script: string): string[] {
  return ['--disable-warning=ExperimentalWarning', path.join(ROOT, script)];
}

async function serve(): Promise<void> {
  const child = spawn(process.execPath, nodeArgs('server/index.ts'), {stdio: 'inherit'});
  child.on('exit', code => process.exit(code ?? 0));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
}

async function init(args: string[]): Promise<void> {
  const repoPath = path.resolve(args[0] ?? process.cwd());
  const project = await api<{id: string; name: string}>('POST', '/api/project', {repoPath});
  console.log(`${bold(project.name)} ready ${dim(repoPath)}`);
}

interface JoinResult {
  handle: string;
  taskId: string;
  worktreePath: string;
  branch: string;
}

async function join(args: string[]): Promise<JoinResult> {
  const {opts} = flags(args);
  if (!opts.name || !opts.agent || !opts.task) fail('usage: align join --name <developer> --agent claude|codex --task "<title>" [--role <role>] [--description <text> | --brief <file>]');
  const description = opts.brief ? readFileSync(opts.brief, 'utf8') : (opts.description ?? '');
  const result = await api<JoinResult>('POST', '/api/join', {developer: opts.name, agent: opts.agent, task: opts.task, role: opts.role ?? '', description});
  console.log(`${agentMark(opts.agent)} ${bold(result.handle)} ${result.taskId}  ${dim(result.worktreePath)}`);
  return result;
}

function worktreeOf(handle: string, snapshot: Snapshot) {
  const session = snapshot.sessions.find(s => s.handle === handle);
  if (!session) fail(`unknown agent ${handle}`);
  return session;
}

function codexExe(): string {
  if (process.env.ALIGN_CODEX_BIN) return process.env.ALIGN_CODEX_BIN;
  if (isWindows && process.env.APPDATA) {
    const exe = path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
    if (existsSync(exe)) return exe;
  }
  return 'codex';
}

function claudeExe(): string {
  if (process.env.ALIGN_CLAUDE_BIN) return process.env.ALIGN_CLAUDE_BIN;
  const local = path.join(homedir(), '.local', 'bin', isWindows ? 'claude.exe' : 'claude');
  return existsSync(local) ? local : 'claude';
}

const KICKOFF = 'Read .align/BRIEF.md and do your task, following its collaboration protocol. Start by calling align.sync.';

/** Starts the agent's own CLI in this terminal, connected to Align. */
async function run(args: string[]): Promise<void> {
  const {positional, opts} = flags(args);
  const handle = positional[0] ?? fail('usage: align run <handle>');
  const snapshot = await api<Snapshot>('GET', '/api/state');
  const session = worktreeOf(handle, snapshot);
  const dir = session.worktreePath;
  const info = JSON.parse(readFileSync(path.join(dir, '.align', 'session.json'), 'utf8')) as {mcpUrl: string};
  const prompt = opts.prompt ?? KICKOFF;

  let exe: string;
  let argv: string[];
  if (session.agent === 'claude') {
    exe = claudeExe();
    argv = [
      '--mcp-config', path.join(dir, '.align', 'mcp.json'),
      '--settings', path.join(dir, '.align', 'claude-settings.json'),
      '--permission-mode', 'acceptEdits',
      '--allowedTools', 'mcp__align', 'Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'Read', 'Glob', 'Grep',
      '-n', handle,
      ...(opts.model ? ['--model', opts.model] : []),
      prompt,
    ];
  } else {
    exe = codexExe();
    const effort = opts.effort ?? 'high';
    argv = [
      '-a', 'never',
      '-s', 'workspace-write',
      '-c', `model_reasoning_effort="${effort}"`,
      '-c', `mcp_servers.align.url="${info.mcpUrl}"`,
      '-c', 'mcp_servers.align.default_tools_approval_mode="approve"',
      '-c', 'mcp_servers.align.tool_timeout_sec=300',
      '-c', 'check_for_update_on_startup=false',
      ...(opts.model ? ['-m', opts.model] : []),
      prompt,
    ];
  }
  const env = {...process.env};
  for (const key of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[key];
  const child = spawn(exe, argv, {cwd: dir, stdio: 'inherit', env});
  child.on('exit', code => process.exit(code ?? 0));
  child.on('error', error => fail(`${exe}: ${error.message}`));
}

/** Opens one Windows Terminal window: the first agent on the left, the second on the right. */
async function launch(args: string[]): Promise<void> {
  const {positional, opts} = flags(args);
  if (positional.length < 2) fail('usage: align launch <left-handle> <right-handle>');
  const snapshot = await api<Snapshot>('GET', '/api/state');
  const [left, right] = positional.map(h => worktreeOf(h!, snapshot));
  const alignCmd = (handle: string) => [process.execPath, ...nodeArgs('bin/align.ts'), 'run', handle, ...(opts.model ? [] : [])];
  if (!isWindows) fail('launch uses Windows Terminal; elsewhere run `align run <handle>` in two terminals');
  const wtArgs = [
    '-w', 'new',
    'new-tab', '--title', left!.handle, '-d', left!.worktreePath, ...alignCmd(left!.handle),
    ';', 'split-pane', '-V', '--title', right!.handle, '-d', right!.worktreePath, ...alignCmd(right!.handle),
  ];
  if (opts.watch !== 'false') wtArgs.push(';', 'split-pane', '-H', '-s', '0.25', '--title', 'align', '-d', ROOT, process.execPath, ...nodeArgs('bin/align.ts'), 'watch');
  spawn('wt', wtArgs, {detached: true, stdio: 'ignore'}).unref();
  console.log(`launched ${left!.handle} | ${right!.handle}`);
}

async function status(): Promise<void> {
  printStatus(await api<Snapshot>('GET', '/api/state'));
}

async function watch(): Promise<void> {
  let seen = 0;
  const connect = () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.on('message', raw => {
      const event = JSON.parse(String(raw));
      if (event.type !== 'snapshot') return;
      const snapshot = event.data as Snapshot;
      const fresh = snapshot.activity.filter(a => a.id > seen).sort((a, b) => a.id - b.id);
      if (seen === 0 && fresh.length) {
        seen = fresh[fresh.length - 1]!.id;
        console.log(dim(`${time(Date.now())}  watching ${snapshot.project?.name ?? ''} · ${snapshot.sessions.map(s => s.handle).join(', ')}`));
        return;
      }
      for (const a of fresh) {
        seen = Math.max(seen, a.id);
        const line = describe(snapshot, a);
        if (line) console.log(`${dim(time(a.createdAt))}  ${line}`);
      }
    });
    ws.on('close', () => setTimeout(connect, 1500));
    ws.on('error', () => {});
  };
  connect();
}

async function demo(args: string[]): Promise<void> {
  const {opts} = flags(args);
  const target = path.resolve(opts.dir ?? path.join(homedir(), 'align-demo', 'taskboard'));
  if (existsSync(target)) {
    if (opts.reset !== 'true') fail(`${target} exists; pass --reset to recreate it`);
    rmSync(target, {recursive: true, force: true});
  }
  mkdirSync(path.dirname(target), {recursive: true});
  cpSync(path.join(ROOT, 'demo', 'taskboard'), target, {recursive: true});
  const git = (...a: string[]) => {
    const r = spawnSync('git', a, {cwd: target, encoding: 'utf8'});
    if (r.status !== 0) fail(`git ${a.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=align', '-c', 'user.email=align@localhost', 'commit', '-qm', 'Taskboard starter');
  await init([target]);
  const briefs = path.join(ROOT, 'demo', 'briefs');
  const a = await join(['--name', opts.a ?? 'Alice', '--agent', 'claude', '--role', 'Frontend developer', '--task', 'Task editor UI (title + assignee, save)', '--brief', path.join(briefs, 'frontend.md')]);
  const b = await join(['--name', opts.b ?? 'Bob', '--agent', 'codex', '--role', 'Backend developer', '--task', 'Task update API + persistence (no lost concurrent edits)', '--brief', path.join(briefs, 'backend.md')]);
  if (opts.launch !== 'false') await launch([a.handle, b.handle]);
  writeFileSync(path.join(path.dirname(target), 'last-demo.json'), JSON.stringify({repo: target, claude: a, codex: b}, null, 2));
}

const commands: Record<string, (args: string[]) => Promise<unknown>> = {serve, init, join, run, launch, status, watch, demo};
const handler = commands[command];
if (!handler) {
  console.log(`align <command>

  serve                         start the collaboration layer (MCP + GBrain)
  init [repo]                   use a git repo as the shared project
  join --name N --agent A --task T [--role R] [--brief file]
                                register an agent, its worktree and task
  run <handle>                  start that agent's own CLI, connected
  launch <left> <right>         open both agents side by side (Windows Terminal)
  status                        agents, tasks, memory, messages
  watch                         live coordination events
  demo [--reset]                prepared taskboard demo: init, join, launch`);
  process.exit(command === 'help' ? 0 : 1);
}
await handler(rest);
