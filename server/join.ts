// Connects a native Claude Code or Codex terminal session to Align: one worktree,
// one session row, one task, and the files the agent and its launcher read.
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import type {AgentKind} from '../shared/types.ts';
import type {App} from './contracts.ts';
import {agentBrief} from './brief.ts';

export interface JoinInput {
  developer: string;
  agent: AgentKind;
  task: string;
  description: string;
  role: string;
}

export interface JoinResult {
  sessionId: string;
  handle: string;
  taskId: string;
  worktreePath: string;
  branch: string;
  mcpUrl: string;
}

const ROOT = path.resolve(import.meta.dirname, '..');

/** Adds `.align/` to the repo's shared exclude file so the commit tool never stages it. */
function excludeAlignDir(worktreePath: string): void {
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {cwd: worktreePath, encoding: 'utf8'}).trim();
  const exclude = path.join(path.resolve(worktreePath, common), 'info', 'exclude');
  mkdirSync(path.dirname(exclude), {recursive: true});
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (!current.split(/\r?\n/).includes('.align/')) appendFileSync(exclude, `${current.endsWith('\n') || current === '' ? '' : '\n'}.align/\n`);
}

/** The same record each CLI writes when its trust prompt is accepted, so the new worktree opens without one. */
function trustForClaude(dir: string): void {
  const file = path.join(homedir(), '.claude.json');
  if (!existsSync(file)) return;
  const key = dir.split(path.sep).join('/');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const config = JSON.parse(readFileSync(file, 'utf8')) as {projects?: Record<string, Record<string, unknown>>};
      config.projects ??= {};
      if (config.projects[key]?.hasTrustDialogAccepted === true) return;
      config.projects[key] = {...(config.projects[key] ?? {}), hasTrustDialogAccepted: true};
      writeFileSync(file, JSON.stringify(config, null, 2));
      return;
    } catch {
      // A running Claude Code may be mid-write; retry.
    }
  }
}

function trustForCodex(dir: string): void {
  const home = process.env.CODEX_HOME || path.join(homedir(), '.codex');
  const file = path.join(home, 'config.toml');
  if (!existsSync(file)) return;
  const current = readFileSync(file, 'utf8');
  const key = dir.toLowerCase();
  if (current.includes(`[projects.'${key}']`)) return;
  appendFileSync(file, `${current.endsWith('\n') ? '' : '\n'}\n[projects.'${key}']\ntrust_level = "trusted"\n`);
}

export async function joinAgent(app: App, input: JoinInput): Promise<JoinResult> {
  const project = app.store.getProject();
  if (!project) throw new Error('no project: run `align init <repo>` first');
  const developer = app.store.upsertDeveloper(input.developer);
  const handle = app.store.allocateHandle(developer.id, input.agent);
  const branch = `align/${handle}`;
  const worktreePath = path.join(app.config.worktreesDir, project.id, handle);
  const baseSha = await app.git.createWorktree(project.repoPath, project.baseBranch, branch, worktreePath);

  const session = app.store.createSession({
    handle,
    developerId: developer.id,
    agent: input.agent,
    title: input.task,
    branch,
    worktreePath,
    baseSha,
    mcpToken: randomBytes(24).toString('hex'),
  });
  const task = app.store.createTask({title: input.task, description: input.description, status: 'in_progress', sessionId: session.id});
  app.store.updateSession(session.id, {taskId: task.id});
  app.store.addActivity({type: 'session_started', actorSessionId: session.id, taskId: task.id, subject: handle});
  app.store.addActivity({type: 'task_registered', actorSessionId: session.id, taskId: task.id, subject: task.title});

  const mcpUrl = `http://127.0.0.1:${app.config.port}/mcp/${session.mcpToken}`;
  const dir = path.join(worktreePath, '.align');
  mkdirSync(dir, {recursive: true});
  writeFileSync(path.join(dir, 'session.json'), JSON.stringify({server: `http://127.0.0.1:${app.config.port}`, token: session.mcpToken, handle, agent: input.agent, mcpUrl}, null, 2));
  writeFileSync(path.join(dir, 'BRIEF.md'), agentBrief(app, session.id, input.role));
  writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({mcpServers: {align: {type: 'http', url: mcpUrl}}}, null, 2));
  if (input.agent === 'claude') writeFileSync(path.join(dir, 'claude-settings.json'), JSON.stringify(claudeSettings(), null, 2));
  excludeAlignDir(worktreePath);
  if (input.agent === 'claude') trustForClaude(worktreePath);
  else trustForCodex(worktreePath);

  app.bus.touch();
  return {sessionId: session.id, handle, taskId: task.id, worktreePath, branch, mcpUrl};
}

function claudeSettings() {
  const node = process.execPath.split(path.sep).join('/');
  const hook = path.join(ROOT, 'bin', 'hook.ts').split(path.sep).join('/');
  const command = (event: string) => `"${node}" --disable-warning=ExperimentalWarning "${hook}" ${event}`;
  return {
    permissions: {allow: ['mcp__align']},
    hooks: {
      PostToolUse: [{matcher: '*', hooks: [{type: 'command', command: command('post'), timeout: 15}]}],
      UserPromptSubmit: [{hooks: [{type: 'command', command: command('prompt'), timeout: 15}]}],
      Stop: [{hooks: [{type: 'command', command: command('stop'), timeout: 15}, {type: 'command', command: command('rewake'), asyncRewake: true, timeout: 1800}]}],
    },
  };
}
