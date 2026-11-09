// align — CLI for the Align collaboration layer.
import {spawn, spawnSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type {Activity, Snapshot} from '../shared/types.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
// `--port N` works anywhere on the command line, so windows opened by `launch` reach the right server.
const portFlag = process.argv.indexOf('--port');
const portValue = portFlag > 1 ? process.argv.splice(portFlag, 2)[1] : undefined;
const PORT = Number(portValue || process.env.ALIGN_PORT || 4600);
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
const red = paint('31');

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
    case 'decision_requested': return `${actor} ${yellow('asks ' + data.developer)}  ${bold(a.subject)}  ${data.question}`;
    case 'decision_conflict': return `${actor} ${red('conflict')}  ${bold(a.subject)}  ${data.owner}: ${data.approved}  ≠  ${data.proposer}: ${data.proposed}  ${dim('→ asking ' + data.owner)}`;
    case 'decision_recorded': return `${actor} ${green(data.developer + ' decided')}  ${bold(a.subject)} v${data.version}  ${data.decision}`;
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
  // --idle opens the agent without a first prompt, so the developer starts it.
  const prompt = opts.idle === 'true' ? null : (opts.prompt ?? KICKOFF);

  let exe: string;
  let argv: string[];
  if (session.agent === 'claude') {
    exe = claudeExe();
    argv = [
      '--mcp-config', path.join(dir, '.align', 'mcp.json'),
      '--settings', path.join(dir, '.align', 'claude-settings.json'),
      '--permission-mode', 'acceptEdits',
      // The browser extension asks for tab access mid-task and stalls an unattended terminal.
      '--no-chrome',
      '--allowedTools', 'mcp__align', 'Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'Read', 'Glob', 'Grep',
      '-n', handle,
      ...(opts.model ? ['--model', opts.model] : []),
      ...(prompt ? [prompt] : []),
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
      ...(prompt ? [prompt] : []),
    ];
  }
  const env = {...process.env};
  for (const key of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[key];
  const child = spawn(exe, argv, {cwd: dir, stdio: 'inherit', env});
  child.on('exit', code => process.exit(code ?? 0));
  child.on('error', error => fail(`${exe}: ${error.message}`));
}

const AGENT_LABEL: Record<string, string> = {claude: 'Claude Code', codex: 'Codex'};
const TAB_COLOR: Record<string, string> = {claude: '#D97757', codex: '#2F3437'};

function screenArea(): {x: number; y: number; width: number; height: number} {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; $a=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; "$($a.X) $($a.Y) $($a.Width) $($a.Height)"'], {encoding: 'utf8'});
  const [x, y, width, height] = (r.stdout ?? '').trim().split(/\s+/).map(Number);
  return width ? {x: x!, y: y!, width, height: height!} : {x: 0, y: 0, width: 1920, height: 1040};
}

/**
 * One Windows Terminal window per developer, titled "<developer> · <agent>" and placed
 * side by side, plus a coordination window below. The title is fixed so the agent cannot replace it.
 */
async function launch(args: string[]): Promise<void> {
  const {positional, opts} = flags(args);
  if (positional.length < 2) fail('usage: align launch <left-handle> <right-handle>');
  if (!isWindows) fail('launch uses Windows Terminal; elsewhere run `align run <handle>` in two terminals');
  const snapshot = await api<Snapshot>('GET', '/api/state');
  const sessions = positional.map(h => worktreeOf(h!, snapshot));
  const self = (...a: string[]) => [process.execPath, ...nodeArgs('bin/align.ts'), ...a, '--port', String(PORT)];
  const area = screenArea();
  const watchHeight = opts.watch === 'false' ? 0 : Math.round(area.height * 0.28);
  // Measured on Windows Terminal's default profile: about 10 x 25 px per character cell.
  const cell = {w: 10, h: 25};
  const half = Math.floor(area.width / 2);
  const window = (name: string, title: string, color: string, dir: string, x: number, y: number, w: number, h: number, command: string[]) => {
    spawn('wt', [
      '-w', name, '--pos', `${x},${y}`, '--size', `${Math.max(40, Math.floor(w / cell.w) - 2)},${Math.max(10, Math.floor(h / cell.h) - 3)}`,
      'new-tab', '--title', title, '--suppressApplicationTitle', '--tabColor', color, '-d', dir, ...command,
    ], {detached: true, stdio: 'ignore'}).unref();
  };
  sessions.forEach((session, i) => {
    const developer = snapshot.developers.find(d => d.id === session.developerId)?.name ?? session.handle;
    const title = `${developer} · ${AGENT_LABEL[session.agent] ?? session.agent}`;
    window(`align-${session.handle}`, title, TAB_COLOR[session.agent] ?? '#666666', session.worktreePath, area.x + i * half, area.y, half, area.height - watchHeight, self('run', session.handle, ...(opts.idle === 'true' ? ['--idle'] : [])));
  });
  if (watchHeight) window('align-watch', 'Align · coordination', '#FF6600', ROOT, area.x, area.y + area.height - watchHeight, area.width, watchHeight, self('watch'));
  // Windows Terminal scales --pos by the display's DPI, so place the windows exactly once they exist.
  const titles = sessions.map(session => `${snapshot.developers.find(d => d.id === session.developerId)?.name ?? session.handle} · ${AGENT_LABEL[session.agent] ?? session.agent}`);
  const top = area.height - watchHeight;
  const places = [...titles.map((title, i) => [title, area.x + i * half, area.y, i === titles.length - 1 ? area.width - i * half : half, top] as const),
    ...(watchHeight ? [['Align · coordination', area.x, area.y + top, area.width, watchHeight] as const] : [])];
  await new Promise(resolve => setTimeout(resolve, 4000));
  tile(places.map(([title, x, y, w, h]) => ({title, x, y, w, h})));
  console.log(`launched ${sessions.map(s => s.handle).join(' | ')}`);
}

function tile(places: {title: string; x: number; y: number; w: number; h: number}[]): void {
  const table = places.map(p => `'${p.title.replace(/'/g, "''")}'=@(${p.x},${p.y},${p.w},${p.h})`).join(';');
  const script = `Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class AlignTile { public delegate bool P(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(P f, IntPtr l);
 [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f); }
"@
$global:pos = @{${table}}
[AlignTile]::EnumWindows({ param($h,$l) if ([AlignTile]::IsWindowVisible($h)) { $t = New-Object Text.StringBuilder 256; [void][AlignTile]::GetWindowText($h,$t,256); $p = $global:pos[$t.ToString()]; if ($p) { [void][AlignTile]::SetWindowPos($h, [IntPtr]::Zero, $p[0], $p[1], $p[2], $p[3], 0x0040) } }; $true }, [IntPtr]::Zero) | Out-Null`;
  spawnSync('powershell', ['-NoProfile', '-Command', script], {stdio: 'ignore'});
}

/** Reads GBrain's own page files (its markdown write-through), not Align's mirror. */
async function memory(args: string[]): Promise<void> {
  if (args.includes('--open')) {
    const url = `${SERVER}/memory`;
    await api('GET', '/api/memory');
    spawn(isWindows ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open', isWindows ? ['/c', 'start', '', url] : [url], {detached: true, stdio: 'ignore'}).unref();
    console.log(url);
    return;
  }
  const home = path.resolve(process.env.ALIGN_HOME || path.join(homedir(), '.align'));
  const contentRoot = path.join(home, 'gbrain', '.gbrain', 'content');
  const pages: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md') && full.includes(`${path.sep}align${path.sep}`)) pages.push(full);
    }
  };
  if (existsSync(contentRoot)) walk(contentRoot);
  if (pages.length === 0) fail(`no Align pages in GBrain at ${contentRoot}`);
  const key = args[0];
  for (const file of pages) {
    const slug = file.slice(file.indexOf(`${path.sep}align${path.sep}`) + 1).replace(/\.md$/, '').split(path.sep).join('/');
    if (key && !slug.endsWith(`/${key}`)) continue;
    if (!key) {
      const text = readFileSync(file, 'utf8');
      const folded = /^title:\s*[>|]-?\s*\n((?:[ \t]+.*\n?)+)/m.exec(text)?.[1];
      const title = folded ? folded.replace(/\s+/g, ' ').trim() : (/^title:\s*["']?(.*?)["']?\s*$/m.exec(text)?.[1] ?? '');
      const version = /^align_version:\s*(\d+)/m.exec(text)?.[1] ?? '?';
      console.log(`${bold(slug)} v${version}  ${dim(title)}`);
    } else {
      console.log(dim(file));
      console.log(readFileSync(file, 'utf8'));
    }
  }
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
  const scenario = opts.scenario ?? 'editor';
  const template = scenario === 'game' || scenario === 'flappy' ? scenario : 'taskboard';
  const target = path.resolve(opts.dir ?? path.join(homedir(), 'align-demo', template));
  if (existsSync(target)) {
    if (opts.reset !== 'true') fail(`${target} exists; pass --reset to recreate it`);
    rmSync(target, {recursive: true, force: true});
  }
  mkdirSync(path.dirname(target), {recursive: true});
  cpSync(path.join(ROOT, 'demo', template), target, {recursive: true});
  const git = (...a: string[]) => {
    const r = spawnSync('git', a, {cwd: target, encoding: 'utf8'});
    if (r.status !== 0) fail(`git ${a.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=align', '-c', 'user.email=align@localhost', 'commit', '-qm', 'Starter');
  await init([target]);
  const briefs = path.join(ROOT, 'demo', 'briefs', scenario === 'editor' ? '' : scenario);
  const titles: Record<string, [string, string]> = {
    editor: ['Task editor UI (title + assignee, save)', 'Task update API + persistence (no lost concurrent edits)'],
    delete: ['Delete button in the task list', 'Task delete API'],
    game: ['YC game structure: loop, state, entities, scoring', 'Game visual design (live design requests)'],
    flappy: ['Demo Day Flight: game logic and the bird', 'Demo Day Flight: visual design (live requests)'],
  };
  const roles: Record<string, [string, string]> = {game: ['Game architect', 'Game designer'], flappy: ['Game developer', 'Game designer']};
  const [frontRole, backRole] = roles[scenario] ?? ['Frontend developer', 'Backend developer'];
  const [frontTask, backTask] = titles[scenario] ?? fail(`unknown scenario ${scenario}`);
  const a = await join(['--name', opts.a ?? 'James', '--agent', 'claude', '--role', frontRole, '--task', frontTask, '--brief', path.join(briefs, 'frontend.md')]);
  const b = await join(['--name', opts.b ?? 'Bumsoo', '--agent', 'codex', '--role', backRole, '--task', backTask, '--brief', path.join(briefs, 'backend.md')]);
  if (opts.launch !== 'false') await launch([a.handle, b.handle, ...(opts.idle === 'true' ? ['--idle'] : [])]);
  writeFileSync(path.join(path.dirname(target), 'last-demo.json'), JSON.stringify({repo: target, claude: a, codex: b}, null, 2));
}

const commands: Record<string, (args: string[]) => Promise<unknown>> = {serve, init, join, run, launch, status, watch, demo, memory};
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
  memory [key]                  pages stored in GBrain (all, or one in full)
  memory --open                 open the shared memory viewer in the browser
  watch                         live coordination events
  demo [--reset]                prepared taskboard demo: init, join, launch`);
  process.exit(command === 'help' ? 0 : 1);
}
await handler(rest);
