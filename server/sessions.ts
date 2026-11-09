import {randomBytes, randomUUID} from 'node:crypto';
import path from 'node:path';
import type {AgentKind, ChatItem, Session, ToolInfo} from '../shared/types.ts';
import {createClaudeRunner, firstLine} from './agents/claude.ts';
import {createCodexRunner} from './agents/codex.ts';
import type {AgentRunner, App, DeliveryResult, RunnerEvent, RunnerFactory, RunnerOptions, SessionManager, SessionRow, TurnStatus} from './contracts.ts';
import {systemPrompt} from './prompts.ts';

const SCAN_DEBOUNCE_MS = 1500;
const MAX_TOOL_OUTPUT = 20 * 1024;
const MAX_TITLE = 80;

type RunnerFactories = Record<AgentKind, RunnerFactory>;

interface PendingInput {
  messageIds: string[];
  userText: string | null;
}

interface OpenItem {
  text: string;
  tool: ToolInfo | null;
}

interface Coordination {
  text: string;
  messageIds: string[];
}

interface Live {
  sessionId: string;
  runner: AgentRunner | null;
  generation: number;
  /** From startTurn until the runner's turn_end. */
  turnOpen: boolean;
  /** Input sent to the agent and not yet consumed, by clientId. */
  pending: Map<string, PendingInput>;
  /** User text the agent never took in, sent when the next turn opens. */
  heldUser: string[];
  stashedNativeId: string | null;
  consumedThisTurn: boolean;
  open: Map<string, OpenItem>;
  scanTimer: NodeJS.Timeout | null;
}

const titleFrom = (text: string) => firstLine(text).slice(0, MAX_TITLE);
const capOutput = (output: string) => (output.length > MAX_TOOL_OUTPUT ? output.slice(-MAX_TOOL_OUTPUT) : output);

function toWire(row: SessionRow): Session {
  const {mcpToken: _token, runnerPid: _pid, ...session} = row;
  return session;
}

export function createSessions(
  app: App,
  factories: RunnerFactories = {claude: createClaudeRunner, codex: createCodexRunner},
): SessionManager {
  const lives = new Map<string, Live>();
  let stopped = false;

  const requireSession = (id: string): SessionRow => {
    const session = app.store.getSession(id);
    if (!session) throw new Error(`unknown session ${id}`);
    return session;
  };

  const liveFor = (sessionId: string): Live => {
    let live = lives.get(sessionId);
    if (!live) {
      live = {
        sessionId,
        runner: null,
        generation: 0,
        turnOpen: false,
        pending: new Map(),
        heldUser: [],
        stashedNativeId: null,
        consumedThisTurn: false,
        open: new Map(),
        scanTimer: null,
      };
      lives.set(sessionId, live);
    }
    return live;
  };

  const emitItem = (item: ChatItem) => app.bus.emit({type: 'item', item});

  const addUserItem = (sessionId: string, developerId: string, text: string) =>
    emitItem(app.store.addItem({sessionId, kind: 'user', text, developerId}));

  const addCoordinationItem = (sessionId: string, coordination: Coordination) =>
    emitItem(app.store.addItem({sessionId, kind: 'coordination', text: coordination.text, messageIds: coordination.messageIds}));

  // ---- File scans

  const scanFiles = async (sessionId: string) => {
    const session = requireSession(sessionId);
    const changes = await app.git.listChanges(session.worktreePath, session.baseSha, session.id);
    app.store.replaceFiles(session.id, changes);
    app.coordination.onFilesChanged(session.id);
    app.bus.touch();
  };

  const clearScanTimer = (live: Live) => {
    if (live.scanTimer) clearTimeout(live.scanTimer);
    live.scanTimer = null;
  };

  const scheduleScan = (live: Live) => {
    clearScanTimer(live);
    live.scanTimer = setTimeout(() => {
      live.scanTimer = null;
      scanFiles(live.sessionId).catch(error => console.error('file scan failed:', error));
    }, SCAN_DEBOUNCE_MS);
  };

  // ---- Turns

  const runnerFor = (live: Live, session: SessionRow): AgentRunner => {
    if (live.runner) return live.runner;
    const options: RunnerOptions = {
      worktreePath: session.worktreePath,
      mcpUrl: `http://127.0.0.1:${app.config.port}/mcp/${session.mcpToken}`,
      // A getter, because the current task can change over the runner's lifetime.
      get systemPrompt() {
        const current = requireSession(session.id);
        const developer = app.store.getDeveloper(current.developerId);
        const task = current.taskId ? app.store.getTask(current.taskId) : null;
        return systemPrompt(current, developer?.name ?? '', task);
      },
      getNativeSessionId: () => app.store.getSession(session.id)?.nativeSessionId ?? null,
      config: app.config,
      onEvent: event => {
        if (stopped) return;
        try {
          handleEvent(live, event);
        } catch (error) {
          console.error('session event handler failed:', error);
        }
      },
    };
    live.runner = factories[session.agent](options);
    return live.runner;
  };

  const openTurn = (live: Live, coordination: Coordination | null, userText: string | null) => {
    const session = requireSession(live.sessionId);
    const held = live.heldUser.splice(0);
    // Without a native session the agent has retained nothing, so everything the developer said goes in.
    const userParts =
      session.nativeSessionId === null
        ? app.store.listItems(session.id).filter(item => item.kind === 'user').map(item => item.text)
        : userText === null
          ? held
          : [...held, userText];
    const user = userParts.join('\n\n');

    live.generation++;
    live.turnOpen = true;
    live.consumedThisTurn = false;
    const clientId = randomUUID();
    live.pending.set(clientId, {messageIds: coordination?.messageIds ?? [], userText: user || null});
    app.store.updateSession(session.id, {status: 'starting', statusDetail: null, lastActiveAt: Date.now()});
    app.bus.touch();
    runnerFor(live, session).startTurn([coordination?.text, user].filter(Boolean).join('\n\n'), clientId);
  };

  const steerInput = (live: Live, text: string, input: PendingInput): boolean => {
    const clientId = randomUUID();
    live.pending.set(clientId, input);
    if (live.runner?.steer(text, clientId)) return true;
    live.pending.delete(clientId);
    return false;
  };

  const settleInput = (live: Live, clientId: string) => {
    const input = live.pending.get(clientId);
    if (!input) return;
    live.pending.delete(clientId);
    if (input.messageIds.length > 0) app.coordination.requeue(input.messageIds);
    if (input.userText) live.heldUser.push(input.userText);
  };

  const persistNativeId = (live: Live) => {
    if (live.stashedNativeId === null) return;
    const session = app.store.getSession(live.sessionId);
    if (session && session.nativeSessionId !== live.stashedNativeId) {
      app.store.updateSession(live.sessionId, {nativeSessionId: live.stashedNativeId});
      app.bus.touch();
    }
  };

  const closeOpenItems = (live: Live) => {
    for (const [itemId, item] of live.open) {
      const tool = item.tool ? {...item.tool, output: capOutput(item.text), status: 'error' as const} : undefined;
      emitItem(app.store.updateItem(itemId, {streaming: false, ...(tool ? {tool} : {text: item.text})}));
    }
    live.open.clear();
  };

  const endTurn = async (live: Live, status: TurnStatus, error: string | null) => {
    if (!live.turnOpen) return;
    live.turnOpen = false;
    clearScanTimer(live);
    for (const clientId of [...live.pending.keys()]) settleInput(live, clientId);
    closeOpenItems(live);
    if (status === 'failed') emitItem(app.store.addItem({sessionId: live.sessionId, kind: 'error', text: error ?? 'Turn failed'}));

    const generation = live.generation;
    if (status === 'completed' && live.heldUser.length > 0) {
      const claimed = app.coordination.claimQueued(live.sessionId);
      if (claimed) addCoordinationItem(live.sessionId, claimed);
      openTurn(live, claimed, null);
    }

    try {
      await scanFiles(live.sessionId);
    } catch (scanError) {
      console.error('file scan failed:', scanError);
    } finally {
      if (generation === live.generation) {
        app.store.updateSession(live.sessionId, {
          status: status === 'failed' ? 'error' : 'idle',
          statusDetail: status === 'failed' ? (error ?? 'Turn failed') : null,
          lastActiveAt: Date.now(),
        });
        app.bus.touch();
        app.coordination.onTurnEnded(live.sessionId, status);
      }
    }
  };

  // ---- Runner events

  const appendToOpenText = (live: Live, itemId: string, text: string) => {
    let item = live.open.get(itemId);
    if (!item) {
      if (app.store.getItem(itemId)) return;
      emitItem(app.store.addItem({id: itemId, sessionId: live.sessionId, kind: 'assistant', text: '', streaming: true}));
      item = {text: '', tool: null};
      live.open.set(itemId, item);
    }
    item.text += text;
    app.store.updateItem(itemId, {text: item.text});
    app.bus.emit({type: 'delta', sessionId: live.sessionId, itemId, text});
  };

  const handleEvent = (live: Live, event: RunnerEvent) => {
    const {sessionId} = live;
    switch (event.type) {
      case 'native_session':
        live.stashedNativeId = event.id;
        if (live.consumedThisTurn) persistNativeId(live);
        return;
      case 'pid':
        app.store.updateSession(sessionId, {runnerPid: event.pid});
        return;
      case 'turn_started':
        if (!live.turnOpen) return;
        app.store.updateSession(sessionId, {status: 'running', lastActiveAt: Date.now()});
        app.bus.touch();
        return;
      case 'text_delta':
        appendToOpenText(live, event.itemId, event.text);
        return;
      case 'text_done': {
        if (live.open.delete(event.itemId)) {
          emitItem(app.store.updateItem(event.itemId, {text: event.text, streaming: false}));
        } else if (!app.store.getItem(event.itemId)) {
          emitItem(app.store.addItem({id: event.itemId, sessionId, kind: 'assistant', text: event.text, streaming: false}));
        }
        return;
      }
      case 'tool_start': {
        if (live.open.has(event.itemId) || app.store.getItem(event.itemId)) return;
        const tool: ToolInfo = {name: event.name, category: event.category, summary: event.summary, output: '', status: 'running'};
        emitItem(app.store.addItem({id: event.itemId, sessionId, kind: 'tool', text: '', tool, streaming: true}));
        live.open.set(event.itemId, {text: '', tool});
        return;
      }
      case 'tool_output': {
        const item = live.open.get(event.itemId);
        if (!item) return;
        item.text = capOutput(item.text + event.text);
        app.bus.emit({type: 'delta', sessionId, itemId: event.itemId, text: event.text});
        return;
      }
      case 'tool_end': {
        const item = live.open.get(event.itemId);
        if (!item?.tool) return;
        live.open.delete(event.itemId);
        const tool: ToolInfo = {...item.tool, output: capOutput(event.output || item.text), status: event.ok ? 'ok' : 'error'};
        emitItem(app.store.updateItem(event.itemId, {tool, streaming: false}));
        scheduleScan(live);
        return;
      }
      case 'input_consumed': {
        live.consumedThisTurn = true;
        persistNativeId(live);
        const input = live.pending.get(event.clientId);
        if (!input) return;
        live.pending.delete(event.clientId);
        if (input.messageIds.length > 0) app.coordination.markRead(input.messageIds);
        return;
      }
      case 'input_rejected':
        settleInput(live, event.clientId);
        return;
      case 'turn_end':
        endTurn(live, event.status, event.error).catch(error => console.error('turn end failed:', error));
        return;
      case 'exit':
        // A new turn may already be waiting on this exit; its input is not this process's.
        if (!live.turnOpen) for (const clientId of [...live.pending.keys()]) settleInput(live, clientId);
        app.store.updateSession(sessionId, {runnerPid: null});
        return;
    }
  };

  const prompt = async (sessionId: string, developerId: string, text: string): Promise<void> => {
    const session = requireSession(sessionId);
    app.store.updateSession(sessionId, {autoTurns: 0, lastActiveAt: Date.now()});

    const task = session.taskId ? app.store.getTask(session.taskId) : null;
    if (task?.status === 'done') {
      const title = titleFrom(text);
      const next = app.store.createTask({title, description: '', status: 'in_progress', sessionId});
      app.store.updateSession(sessionId, {taskId: next.id});
      app.store.addActivity({type: 'task_registered', actorSessionId: sessionId, taskId: next.id, subject: title});
    }

    const live = liveFor(sessionId);
    if (live.turnOpen) {
      addUserItem(sessionId, developerId, text);
      if (!steerInput(live, text, {messageIds: [], userText: text})) live.heldUser.push(text);
      app.bus.touch();
      return;
    }

    const claimed = app.coordination.claimQueued(sessionId);
    if (claimed) addCoordinationItem(sessionId, claimed);
    addUserItem(sessionId, developerId, text);
    openTurn(live, claimed, text);
  };

  return {
    prompt,

    async create({developerId, agent, prompt: firstPrompt}) {
      if (!app.store.getDeveloper(developerId)) throw new Error(`unknown developer ${developerId}`);
      const project = app.store.getProject();
      if (!project) throw new Error('no project configured');

      const handle = app.store.allocateHandle(developerId, agent);
      const branch = `align/${handle}`;
      const worktreePath = path.join(app.config.worktreesDir, project.id, handle);
      const baseSha = await app.git.createWorktree(project.repoPath, project.baseBranch, branch, worktreePath);

      const title = titleFrom(firstPrompt);
      const row = app.store.createSession({
        handle,
        developerId,
        agent,
        title,
        branch,
        worktreePath,
        baseSha,
        mcpToken: randomBytes(24).toString('hex'),
      });
      const task = app.store.createTask({title, description: '', status: 'in_progress', sessionId: row.id});
      app.store.updateSession(row.id, {taskId: task.id});
      app.store.addActivity({type: 'session_started', actorSessionId: row.id, taskId: task.id, subject: handle});
      app.store.addActivity({type: 'task_registered', actorSessionId: row.id, taskId: task.id, subject: title});

      await prompt(row.id, developerId, firstPrompt);
      return toWire(requireSession(row.id));
    },

    deliver(sessionId, text, messageIds, wake): DeliveryResult {
      if (stopped) return 'queued';
      const session = app.store.getSession(sessionId);
      if (!session || session.status === 'error') return 'queued';
      const live = liveFor(sessionId);
      const canWake = session.status === 'idle' && wake && session.nativeSessionId !== null;
      if (!live.turnOpen && !canWake) return 'queued';

      if (wake && session.autoTurns >= app.config.maxAutoTurns) {
        app.store.addActivity({type: 'wake_limit', targetSessionId: sessionId, taskId: session.taskId, subject: messageIds[0] ?? '', data: {messageIds}});
        app.bus.touch();
        return 'over_budget';
      }

      const coordination = {text, messageIds};
      let result: DeliveryResult;
      if (live.turnOpen) {
        if (!steerInput(live, text, {messageIds, userText: null})) return 'queued';
        addCoordinationItem(sessionId, coordination);
        result = 'steered';
      } else {
        addCoordinationItem(sessionId, coordination);
        openTurn(live, coordination, null);
        result = 'started';
      }
      if (wake) app.store.updateSession(sessionId, {autoTurns: session.autoTurns + 1});
      app.bus.touch();
      return result;
    },

    interrupt(sessionId) {
      const live = lives.get(sessionId);
      if (!live) return;
      live.heldUser = [];
      for (const input of live.pending.values()) input.userText = null;
      if (live.turnOpen) live.runner?.interrupt();
    },

    async shutdown() {
      stopped = true;
      for (const live of lives.values()) clearScanTimer(live);
      await Promise.allSettled([...lives.values()].map(live => live.runner?.dispose()));
    },
  };
}
