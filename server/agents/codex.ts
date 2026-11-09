import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import type {RunnerEvent, RunnerFactory, TurnStatus} from '../contracts.ts';
import {agentEnv, alignSummary, displayPath, firstLine, startProcess, waitForGone} from './claude.ts';
import type {AgentProcess} from './claude.ts';

type State = 'idle' | 'starting' | 'active';

const textInput = (text: string) => [{type: 'text', text, text_elements: []}];

function userMcpServers(): string[] {
  const home = process.env.CODEX_HOME || path.join(homedir(), '.codex');
  let config: string;
  try {
    config = readFileSync(path.join(home, 'config.toml'), 'utf8');
  } catch {
    return [];
  }
  const headers = config.matchAll(/^[ \t]*\[mcp_servers\.("[^"\r\n]+"|'[^'\r\n]+'|[A-Za-z0-9_-]+)\][ \t]*(?:#.*)?\r?$/gm);
  return [...headers].map(match => match[1]).filter(name => name !== 'align');
}

function spawnArgs(mcpUrl: string): string[] {
  const args = [
    'app-server',
    '-c', `mcp_servers.align.url=${JSON.stringify(mcpUrl)}`,
    '-c', 'mcp_servers.align.default_tools_approval_mode="approve"',
    '-c', 'notify=[]',
  ];
  for (const server of userMcpServers()) args.push('-c', `mcp_servers.${server}.enabled=false`);
  args.push('--disable', 'plugins', '--disable', 'hooks', '--disable', 'apps', '--disable', 'memories');
  return args;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const createCodexRunner: RunnerFactory = options => {
  const emit = (event: RunnerEvent) => options.onEvent(event);

  let state: State = 'idle';
  let proc: AgentProcess | null = null;
  let handshake: Promise<unknown> | null = null;
  let threadId: string | null = null;
  let turnId: string | null = null;
  // Invalidates a startup sequence that outlived its turn.
  let turnSeq = 0;
  let interruptWanted = false;
  let turnError: string | null = null;
  let bufferedSteers: {text: string; clientId: string}[] = [];
  const startedTools = new Set<string>();
  const consumed = new Set<string>();
  let onGoneWaiter: (() => void) | null = null;

  let nextRequestId = 1;
  const calls = new Map<number, {resolve: (result: any) => void; reject: (error: Error) => void}>();

  const send = (message: object) => proc?.write(JSON.stringify(message));

  const request = (method: string, params: object): Promise<any> => {
    if (!proc) return Promise.reject(new Error('codex is not running'));
    const id = nextRequestId++;
    return new Promise((resolve, reject) => {
      calls.set(id, {resolve, reject});
      send({id, method, params});
    });
  };

  const finishTurn = (status: TurnStatus, error: string | null) => {
    if (state === 'idle') return;
    state = 'idle';
    turnId = null;
    interruptWanted = false;
    bufferedSteers = [];
    startedTools.clear();
    emit({type: 'turn_end', status, error});
  };

  const sendInterrupt = () => {
    request('turn/interrupt', {threadId, turnId}).catch(() => {});
  };

  const sendSteer = (text: string, clientId: string) => {
    request('turn/steer', {threadId, expectedTurnId: turnId, clientUserMessageId: clientId, input: textInput(text)}).catch(() =>
      emit({type: 'input_rejected', clientId}),
    );
  };

  const ensureThread = async () => {
    if (!proc) launch();
    await handshake;
    if (threadId) return;
    const common = {
      cwd: options.worktreePath,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      developerInstructions: options.systemPrompt,
    };
    const stored = options.getNativeSessionId();
    const model = options.config.codexModel;
    const result = stored
      ? await request('thread/resume', {threadId: stored, ...common})
      : await request('thread/start', {...common, ...(model ? {model} : {})});
    threadId = String(result.thread.id);
    emit({type: 'native_session', id: threadId});
  };

  const runTurn = async (seq: number, text: string, clientId: string) => {
    try {
      await ensureThread();
      if (seq !== turnSeq || state !== 'starting') return;
      await request('turn/start', {
        threadId,
        effort: options.config.codexEffort,
        clientUserMessageId: clientId,
        input: textInput(text),
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [],
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      });
    } catch (error) {
      if (seq === turnSeq) finishTurn('failed', errorMessage(error));
    }
  };

  const startTool = (itemId: string, name: string, category: 'shell' | 'edit' | 'align' | 'other', summary: string) => {
    if (startedTools.has(itemId)) return;
    startedTools.add(itemId);
    emit({type: 'tool_start', itemId, name, category, summary});
  };

  const describeFileChange = (item: any): string => {
    const changes: any[] = Array.isArray(item.changes) ? item.changes : [];
    if (changes.length === 0) return 'fileChange';
    const first = displayPath(options.worktreePath, changes[0]?.path) || 'fileChange';
    return changes.length > 1 ? `${first} +${changes.length - 1}` : first;
  };

  // `command` carries the powershell.exe wrapper; `commandActions` has what the agent actually asked for.
  const describeCommand = (item: any): string => {
    const actions: any[] = Array.isArray(item.commandActions) ? item.commandActions : [];
    const parsed = actions.map(action => action?.command).filter(command => typeof command === 'string' && command).join(' && ');
    return firstLine(parsed || item.command) || 'commandExecution';
  };

  const startToolItem = (item: any) => {
    if (item.type === 'commandExecution') startTool(item.id, 'commandExecution', 'shell', describeCommand(item));
    else if (item.type === 'fileChange') startTool(item.id, 'fileChange', 'edit', describeFileChange(item));
    else if (item.type === 'mcpToolCall') {
      const isAlign = item.server === 'align';
      startTool(item.id, String(item.tool), isAlign ? 'align' : 'other', isAlign ? alignSummary(String(item.tool), item.arguments) : `${item.server}.${item.tool}`);
    }
  };

  const mcpOutput = (item: any): string => {
    if (item.error) return String(item.error?.message ?? JSON.stringify(item.error));
    const content = item.result?.content;
    if (Array.isArray(content)) return content.map((block: any) => (typeof block?.text === 'string' ? block.text : '')).filter(Boolean).join('\n');
    return item.result === undefined || item.result === null ? '' : JSON.stringify(item.result);
  };

  const handleItemCompleted = (item: any) => {
    switch (item.type) {
      case 'agentMessage':
        emit({type: 'text_done', itemId: item.id, text: item.text ?? ''});
        return;
      case 'userMessage':
        consumeUserMessage(item);
        return;
      case 'commandExecution': {
        startToolItem(item);
        const ok = item.status === 'completed' && (item.exitCode === 0 || item.exitCode === null || item.exitCode === undefined);
        emit({type: 'tool_end', itemId: item.id, ok, output: item.aggregatedOutput ?? ''});
        return;
      }
      case 'fileChange': {
        startToolItem(item);
        const output = (Array.isArray(item.changes) ? item.changes : []).map((change: any) => change?.diff ?? change?.path ?? '').join('\n');
        emit({type: 'tool_end', itemId: item.id, ok: item.status === 'completed', output});
        return;
      }
      case 'mcpToolCall':
        startToolItem(item);
        emit({type: 'tool_end', itemId: item.id, ok: item.status === 'completed' && !item.error, output: mcpOutput(item)});
        return;
    }
  };

  const consumeUserMessage = (item: any) => {
    const clientId = item.clientId;
    if (typeof clientId !== 'string' || consumed.has(clientId)) return;
    consumed.add(clientId);
    emit({type: 'input_consumed', clientId});
  };

  const handleNotification = (method: string, params: any) => {
    switch (method) {
      case 'turn/started':
        if (state !== 'starting') return;
        state = 'active';
        turnId = params.turn?.id ?? null;
        emit({type: 'turn_started'});
        if (interruptWanted) {
          sendInterrupt();
          return;
        }
        for (const steer of bufferedSteers.splice(0)) sendSteer(steer.text, steer.clientId);
        return;
      case 'turn/completed': {
        const turn = params.turn ?? {};
        if (turnId !== null && turn.id !== undefined && turn.id !== turnId) return;
        const status: TurnStatus = turn.status === 'completed' ? 'completed' : turn.status === 'interrupted' ? 'interrupted' : 'failed';
        finishTurn(status, status === 'failed' ? (turn.error?.message ?? turnError ?? 'turn failed') : null);
        return;
      }
      case 'error':
        if (!params.willRetry) turnError = String(params.error?.message ?? params.message ?? 'codex error');
        return;
      case 'item/agentMessage/delta':
        emit({type: 'text_delta', itemId: params.itemId, text: params.delta ?? ''});
        return;
      case 'item/commandExecution/outputDelta':
        emit({type: 'tool_output', itemId: params.itemId, text: params.delta ?? ''});
        return;
      case 'item/started':
        if (params.item?.type === 'userMessage') consumeUserMessage(params.item);
        else startToolItem(params.item ?? {});
        return;
      case 'item/completed':
        handleItemCompleted(params.item ?? {});
        return;
    }
  };

  const handleServerRequest = (message: any) => {
    const {id, method} = message;
    if (/^item\/.*\/requestApproval$/.test(method)) send({id, result: {decision: 'accept'}});
    else if (method === 'mcpServer/elicitation/request') send({id, result: {action: 'accept', content: {}, _meta: null}});
    else send({id, error: {code: -32601, message: `unsupported request: ${method}`}});
  };

  const handleMessage = (message: any) => {
    if (message.method && message.id !== undefined) handleServerRequest(message);
    else if (message.method) handleNotification(message.method, message.params ?? {});
    else if (message.id !== undefined) {
      const call = calls.get(message.id);
      if (!call) return;
      calls.delete(message.id);
      if (message.error) call.reject(new Error(String(message.error.message ?? JSON.stringify(message.error))));
      else call.resolve(message.result);
    }
  };

  const handleGone = (error: string | null) => {
    proc = null;
    handshake = null;
    threadId = null;
    consumed.clear();
    for (const call of calls.values()) call.reject(new Error(error ?? 'codex exited'));
    calls.clear();
    if (state !== 'idle') {
      turnSeq++;
      finishTurn(interruptWanted ? 'interrupted' : 'failed', interruptWanted ? null : (error ?? 'codex exited during the turn'));
    }
    emit({type: 'exit', error});
    onGoneWaiter?.();
  };

  const launch = () => {
    proc = startProcess({
      bin: options.config.codexBin,
      args: spawnArgs(options.mcpUrl),
      cwd: options.worktreePath,
      env: agentEnv(),
      onMessage: handleMessage,
      onGone: handleGone,
    });
    emit({type: 'pid', pid: proc.pid});
    handshake = request('initialize', {
      clientInfo: {name: 'align', title: 'Align', version: '0.1.0'},
      capabilities: {experimentalApi: true},
    }).then(() => send({method: 'initialized'}));
  };

  return {
    kind: 'codex',
    startTurn(text, clientId) {
      const seq = ++turnSeq;
      state = 'starting';
      turnId = null;
      turnError = null;
      interruptWanted = false;
      bufferedSteers = [];
      startedTools.clear();
      consumed.clear();
      void runTurn(seq, text, clientId);
    },
    steer(text, clientId) {
      if (state === 'idle') return false;
      if (state === 'active') sendSteer(text, clientId);
      else bufferedSteers.push({text, clientId});
      return true;
    },
    interrupt() {
      if (state === 'idle') return;
      interruptWanted = true;
      if (state === 'active') sendInterrupt();
    },
    async dispose() {
      if (!proc) return;
      interruptWanted = true;
      const waiter = waitForGone();
      onGoneWaiter = waiter.resolve;
      proc.kill();
      await waiter.promise;
    },
  };
};
