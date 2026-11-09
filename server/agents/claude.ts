import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import path from 'node:path';
import type {Readable} from 'node:stream';
import type {ToolCategory} from '../../shared/types.ts';
import type {RunnerEvent, RunnerFactory, TurnStatus} from '../contracts.ts';

// ---- Helpers shared with the Codex runner -----------------------------------

const INHERITED_CLAUDE_VARS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'];
const STDIO_DRAIN_MS = 1000;
const CLOSE_KILL_MS = 5000;
const DISPOSE_WAIT_MS = 3000;

export function agentEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {...process.env, ...extra};
  for (const name of INHERITED_CLAUDE_VARS) delete env[name];
  return env;
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true});
    killer.on('error', () => {});
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function readJsonLines(stream: Readable, onMessage: (message: any) => void): void {
  let buffer = '';
  const consume = (line: string) => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    try {
      onMessage(message);
    } catch (error) {
      console.error('agent event handler failed:', error);
    }
  };
  stream.setEncoding('utf8');
  stream.on('error', () => {});
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      consume(line);
    }
  });
  stream.on('end', () => {
    consume(buffer);
    buffer = '';
  });
}

export interface AgentProcess {
  readonly pid: number | null;
  write(line: string): void;
  endInput(): void;
  kill(): void;
}

/** Spawns a JSONL agent process. `onGone` fires exactly once, asynchronously, including for spawn failures. */
export function startProcess(input: {
  bin: string | null;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onMessage: (message: any) => void;
  onGone: (error: string | null) => void;
}): AgentProcess {
  let finished = false;
  let drainTimer: NodeJS.Timeout | undefined;
  const finish = (error: string | null) => {
    if (finished) return;
    finished = true;
    clearTimeout(drainTimer);
    try {
      input.onGone(error);
    } catch (handlerError) {
      console.error('agent exit handler failed:', handlerError);
    }
  };
  const dead = (error: string): AgentProcess => {
    setImmediate(() => finish(error));
    return {pid: null, write() {}, endInput() {}, kill() {}};
  };

  if (!input.bin) return dead('agent binary not found');
  let child: ChildProcess;
  try {
    child = spawn(input.bin, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
  } catch (error) {
    return dead(error instanceof Error ? error.message : String(error));
  }

  let stderrTail = '';
  let exitError: string | null = null;
  child.on('error', error => {
    if (child.pid === undefined) finish(error.message);
  });
  child.stdin!.on('error', () => {});
  child.stderr!.on('error', () => {});
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-2000);
  });
  readJsonLines(child.stdout!, input.onMessage);

  child.once('exit', (code, signal) => {
    exitError = code === 0 ? null : stderrTail.replace(/\u001b\[[0-9;]*m/g, '').trim() || `process exited with ${code ?? signal}`;
    // Output may still be in the pipe, but a background grandchild can hold it open forever.
    drainTimer = setTimeout(() => finish(exitError), STDIO_DRAIN_MS);
  });
  child.once('close', () => finish(exitError));

  return {
    pid: child.pid ?? null,
    write(line) {
      if (child.stdin!.writable) child.stdin!.write(`${line}\n`);
    },
    endInput() {
      child.stdin!.end();
    },
    kill() {
      killTree(child);
    },
  };
}

/** A promise settled by `resolve`, or after a timeout so shutdown cannot hang on a failed kill. */
export function waitForGone(): {promise: Promise<void>; resolve: () => void} {
  let resolve = () => {};
  const promise = new Promise<void>(done => {
    const timer = setTimeout(done, DISPOSE_WAIT_MS);
    resolve = () => {
      clearTimeout(timer);
      done();
    };
  });
  return {promise, resolve};
}

export function firstLine(value: unknown): string {
  if (typeof value !== 'string') return '';
  return (value.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '').slice(0, 200);
}

/** Worktree-relative with forward slashes when the file is inside the worktree. */
export function displayPath(worktreePath: string, file: unknown): string {
  if (typeof file !== 'string') return '';
  if (!path.isAbsolute(file)) return file;
  const relative = path.relative(worktreePath, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.replaceAll('\\', '/') : file;
}

const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  Bash: 'shell',
  PowerShell: 'shell',
  commandExecution: 'shell',
  Edit: 'edit',
  Write: 'edit',
  MultiEdit: 'edit',
  fileChange: 'edit',
  Read: 'read',
  Grep: 'search',
  Glob: 'search',
};

const ALIGN_KEY_ARGUMENTS: Record<string, string[]> = {
  task_update: ['status', 'title'],
  task_register: ['title'],
  memory_search: ['query'],
  memory_get: ['key'],
  memory_publish: ['key'],
  message_send: ['to', 'subject'],
  impact_ack: ['impact_id', 'outcome'],
  commit: ['message'],
  merge: ['branch'],
};

export function alignSummary(tool: string, args: any): string {
  const values = (ALIGN_KEY_ARGUMENTS[tool] ?? []).map(name => args?.[name]).filter(value => typeof value === 'string' && value);
  return firstLine([tool, ...values].join(' '));
}

const ALIGN_PREFIX = 'mcp__align__';

function describeTool(worktreePath: string, rawName: string, input: any): {name: string; category: ToolCategory; summary: string} {
  if (rawName.startsWith(ALIGN_PREFIX)) {
    const name = rawName.slice(ALIGN_PREFIX.length);
    return {name, category: 'align', summary: alignSummary(name, input)};
  }
  const category = TOOL_CATEGORIES[rawName] ?? 'other';
  const summaries: Partial<Record<ToolCategory, unknown>> = {
    shell: input?.command,
    edit: displayPath(worktreePath, input?.file_path),
    read: displayPath(worktreePath, input?.file_path),
    search: input?.pattern,
    other: input?.description ?? input?.prompt ?? input?.url ?? input?.query,
  };
  return {name: rawName, category, summary: firstLine(summaries[category]) || rawName};
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => (typeof block?.text === 'string' ? block.text : '')).filter(Boolean).join('\n');
}

// ---- Claude runner -----------------------------------------------------------

type State = 'idle' | 'starting' | 'active' | 'closing';

const ALLOWED_TOOLS = 'Bash,PowerShell,Edit,MultiEdit,Write,Read,Glob,Grep,TodoWrite,mcp__align';

export const createClaudeRunner: RunnerFactory = options => {
  const emit = (event: RunnerEvent) => options.onEvent(event);

  let state: State = 'idle';
  let proc: AgentProcess | null = null;
  // Set while a new turn waits for the previous process to exit; its input is in `buffered`.
  let awaitingExit = false;
  let buffered: {text: string; clientId: string}[] = [];
  let unreplayed: string[] = [];
  let closeTimer: NodeJS.Timeout | null = null;
  let onGoneWaiter: (() => void) | null = null;

  let messageId = '';
  let blockIndex = 0;
  const openTexts = new Set<string>();

  const writeInput = (text: string, clientId: string) => {
    unreplayed.push(clientId);
    proc?.write(
      JSON.stringify({
        type: 'user',
        uuid: clientId,
        session_id: '',
        parent_tool_use_id: null,
        message: {role: 'user', content: text},
      }),
    );
  };

  const resetTurn = () => {
    awaitingExit = false;
    buffered = [];
    unreplayed = [];
    openTexts.clear();
  };

  const endTurn = (status: TurnStatus, error: string | null) => {
    const running = proc;
    resetTurn();
    state = running ? 'closing' : 'idle';
    if (running && !closeTimer) {
      running.endInput();
      closeTimer = setTimeout(() => running.kill(), CLOSE_KILL_MS);
    }
    emit({type: 'turn_end', status, error});
  };

  const handleStreamEvent = (event: any) => {
    if (event?.type === 'message_start') messageId = event.message?.id ?? '';
    else if (event?.type === 'content_block_start') blockIndex = event.index ?? 0;
    else if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      const itemId = `${messageId}:${event.index ?? blockIndex}`;
      openTexts.add(itemId);
      emit({type: 'text_delta', itemId, text: event.delta.text ?? ''});
    }
  };

  const handleAssistant = (message: any) => {
    const blocks: any[] = Array.isArray(message?.content) ? message.content : [];
    blocks.forEach((block, index) => {
      if (block?.type === 'text') {
        // Thinking blocks shift stream indices, and each `assistant` line may hold a single block.
        const streamed = [...openTexts].find(id => id.startsWith(`${message.id}:`));
        const itemId = streamed ?? `${message.id}:${index}`;
        openTexts.delete(itemId);
        emit({type: 'text_done', itemId, text: block.text ?? ''});
      } else if (block?.type === 'tool_use') {
        emit({type: 'tool_start', itemId: block.id, ...describeTool(options.worktreePath, String(block.name), block.input)});
      }
    });
  };

  const handleUser = (message: any) => {
    if (message.isReplay) {
      const index = unreplayed.indexOf(message.uuid);
      const clientId = index >= 0 ? unreplayed.splice(index, 1)[0] : unreplayed.shift();
      if (clientId) emit({type: 'input_consumed', clientId});
      return;
    }
    const content = message.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      emit({type: 'tool_end', itemId: block.tool_use_id, ok: !block.is_error, output: toolResultText(block.content)});
    }
  };

  const handleMessage = (message: any) => {
    if ((state !== 'starting' && state !== 'active') || awaitingExit) return;
    switch (message.type) {
      case 'system':
        if (message.subtype !== 'init') return;
        emit({type: 'native_session', id: message.session_id});
        if (state === 'starting') {
          state = 'active';
          emit({type: 'turn_started'});
        }
        return;
      case 'stream_event':
        handleStreamEvent(message.event);
        return;
      case 'assistant':
        handleAssistant(message.message);
        return;
      case 'user':
        handleUser(message);
        return;
      case 'result': {
        if (unreplayed.length > 0) return;
        const failed = Boolean(message.is_error) || message.subtype !== 'success';
        endTurn(failed ? 'failed' : 'completed', failed ? String(message.result ?? message.subtype) : null);
        return;
      }
    }
  };

  const launch = () => {
    const nativeId = options.getNativeSessionId();
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--replay-user-messages',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', ALLOWED_TOOLS,
      '--strict-mcp-config',
      '--setting-sources', 'project',
      '--mcp-config', JSON.stringify({mcpServers: {align: {type: 'http', url: options.mcpUrl}}}),
      '--append-system-prompt', options.systemPrompt,
      ...(options.config.claudeModel ? ['--model', options.config.claudeModel] : []),
      ...(nativeId ? ['--resume', nativeId] : []),
    ];
    proc = startProcess({
      bin: options.config.claudeBin,
      args,
      cwd: options.worktreePath,
      env: agentEnv({ENABLE_TOOL_SEARCH: 'false'}),
      onMessage: handleMessage,
      onGone: error => handleGone(error),
    });
    emit({type: 'pid', pid: proc.pid});
    const inputs = buffered;
    buffered = [];
    for (const input of inputs) writeInput(input.text, input.clientId);
  };

  const handleGone = (error: string | null) => {
    proc = null;
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = null;
    if (awaitingExit) {
      awaitingExit = false;
      emit({type: 'exit', error});
      launch();
      return;
    }
    if (state === 'starting' || state === 'active') {
      resetTurn();
      state = 'idle';
      emit({type: 'turn_end', status: 'failed', error: error ?? 'claude exited without a result'});
    } else {
      state = 'idle';
    }
    emit({type: 'exit', error});
    onGoneWaiter?.();
  };

  return {
    kind: 'claude',
    startTurn(text, clientId) {
      buffered = [{text, clientId}];
      if (state === 'closing') {
        state = 'starting';
        awaitingExit = true;
        return;
      }
      state = 'starting';
      launch();
    },
    steer(text, clientId) {
      if (state !== 'starting' && state !== 'active') return false;
      if (awaitingExit) buffered.push({text, clientId});
      else writeInput(text, clientId);
      return true;
    },
    interrupt() {
      if (state !== 'starting' && state !== 'active') return;
      endTurn('interrupted', null);
      proc?.kill();
    },
    async dispose() {
      if (state === 'starting' || state === 'active') endTurn('interrupted', null);
      if (!proc) return;
      const waiter = waitForGone();
      onGoneWaiter = waiter.resolve;
      proc.kill();
      await waiter.promise;
    },
  };
};
