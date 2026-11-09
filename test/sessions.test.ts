import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ChatItem, FileChange, ServerEvent, Task} from '../shared/types.ts';
import type {AgentRunner, App, RunnerEvent, RunnerFactory, RunnerOptions, SessionRow} from '../server/contracts.ts';
import {createSessions} from '../server/sessions.ts';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

interface ScriptedRunner extends AgentRunner {
  starts: {text: string; clientId: string}[];
  steers: {text: string; clientId: string}[];
  interrupts: number;
  steerAccepted: boolean;
  emit(event: RunnerEvent): void;
}

function harness(maxAutoTurns = 8) {
  const sessions = new Map<string, SessionRow>();
  const tasks = new Map<string, Task>();
  const items = new Map<string, ChatItem>();
  const activities: {type: string; subject?: string}[] = [];
  const emitted: Exclude<ServerEvent, {type: 'snapshot'}>[] = [];
  let seq = 0;
  let ids = 0;

  const store = {
    getProject: () => ({id: 'P1', name: 'p', repoPath: '/repo', baseBranch: 'main'}),
    getDeveloper: (id: string) => ({id, name: 'Dev', color: '#000', online: true}),
    allocateHandle: () => 'dev-claude',
    createSession(input: any) {
      const row = {
        ...input,
        id: `S${++ids}`,
        status: 'idle',
        statusDetail: null,
        taskId: null,
        headSha: null,
        nativeSessionId: null,
        runnerPid: null,
        autoTurns: 0,
        createdAt: 1,
        lastActiveAt: 1,
      } as SessionRow;
      sessions.set(row.id, row);
      return row;
    },
    getSession: (id: string) => sessions.get(id) ?? null,
    updateSession(id: string, patch: Partial<SessionRow>) {
      const row = {...sessions.get(id)!, ...patch};
      sessions.set(id, row);
      return row;
    },
    createTask(input: any) {
      const task = {...input, id: `T${++ids}`, note: '', developerId: 'D1', agent: 'claude', branch: '', worktreePath: '', files: [], dependsOn: [], decisions: [], createdAt: 1, updatedAt: 1} as Task;
      tasks.set(task.id, task);
      return task;
    },
    getTask: (id: string) => tasks.get(id) ?? null,
    addItem(input: any) {
      const item: ChatItem = {
        id: input.id ?? `I${++ids}`,
        sessionId: input.sessionId,
        seq: ++seq,
        kind: input.kind,
        text: input.text,
        tool: input.tool ?? null,
        developerId: input.developerId ?? null,
        messageIds: input.messageIds ?? [],
        taskId: input.taskId !== undefined ? input.taskId : (sessions.get(input.sessionId)?.taskId ?? null),
        streaming: input.streaming ?? false,
        createdAt: 1,
      };
      items.set(item.id, item);
      return item;
    },
    updateItem(id: string, patch: Partial<ChatItem>) {
      const item = {...items.get(id)!, ...patch};
      items.set(id, item);
      return item;
    },
    getItem: (id: string) => items.get(id) ?? null,
    listItems: (sessionId: string) => [...items.values()].filter(item => item.sessionId === sessionId).sort((a, b) => a.seq - b.seq),
    replaceFiles() {},
    addActivity(input: {type: string; subject?: string}) {
      activities.push(input);
      return input;
    },
  };

  const coordination = {
    markRead: [] as string[][],
    requeued: [] as string[][],
    turnEnded: [] as string[][],
    filesChanged: 0,
    claim: null as {text: string; messageIds: string[]} | null,
  };

  const git = {
    scan: () => Promise.resolve([] as FileChange[]),
  };

  const runners: ScriptedRunner[] = [];
  const factory: RunnerFactory = (options: RunnerOptions) => {
    const runner: ScriptedRunner = {
      kind: 'claude',
      starts: [],
      steers: [],
      interrupts: 0,
      steerAccepted: true,
      startTurn(text, clientId) {
        runner.starts.push({text, clientId});
      },
      steer(text, clientId) {
        if (!runner.steerAccepted) return false;
        runner.steers.push({text, clientId});
        return true;
      },
      interrupt() {
        runner.interrupts++;
        options.onEvent({type: 'turn_end', status: 'interrupted', error: null});
      },
      dispose: async () => {},
      emit: options.onEvent,
    };
    runners.push(runner);
    return runner;
  };

  const app = {
    config: {port: 4600, worktreesDir: '/wt', maxAutoTurns} as App['config'],
    store: store as unknown as App['store'],
    bus: {touch() {}, emit: (event: Exclude<ServerEvent, {type: 'snapshot'}>) => emitted.push(event)} as unknown as App['bus'],
    git: {
      createWorktree: async () => 'base',
      listChanges: () => git.scan(),
    } as unknown as App['git'],
    coordination: {
      markRead: (ids: string[]) => coordination.markRead.push(ids),
      requeue: (ids: string[]) => coordination.requeued.push(ids),
      claimQueued: () => {
        const claim = coordination.claim;
        coordination.claim = null;
        return claim;
      },
      onFilesChanged: () => coordination.filesChanged++,
      onTurnEnded: (sessionId: string, status: string) => coordination.turnEnded.push([sessionId, status]),
    } as unknown as App['coordination'],
  } as App;

  const manager = createSessions(app, {claude: factory, codex: factory});
  return {app, manager, sessions, tasks, items, activities, emitted, coordination, git, runners, store};
}

type Harness = ReturnType<typeof harness>;

async function newSession(h: Harness, prompt = 'first line\nmore') {
  const session = await h.manager.create({developerId: 'D1', agent: 'claude', prompt});
  const runner = h.runners[h.runners.length - 1];
  return {id: session.id, runner};
}

/** A session with a persisted native id, in an open, consuming turn. */
async function liveSession(h: Harness) {
  const {id, runner} = await newSession(h);
  runner.emit({type: 'native_session', id: 'native-1'});
  runner.emit({type: 'turn_started'});
  runner.emit({type: 'input_consumed', clientId: runner.starts[0].clientId});
  return {id, runner};
}

/** A session that finished its first turn and is idle with a native id. */
async function idleSession(h: Harness) {
  const live = await liveSession(h);
  live.runner.emit({type: 'turn_end', status: 'completed', error: null});
  await tick();
  h.coordination.turnEnded.length = 0;
  return live;
}

test('create builds the row, task and first turn', async () => {
  const h = harness();
  const {id, runner} = await newSession(h);
  const session = h.sessions.get(id)!;
  assert.equal(session.status, 'starting');
  assert.equal(session.branch, 'align/dev-claude');
  assert.equal(h.tasks.get(session.taskId!)!.title, 'first line');
  assert.equal(runner.starts.length, 1);
  assert.equal(runner.starts[0].text, 'first line\nmore');
  assert.equal(h.runners.length, 1);
});

test('steer race: input_rejected requeues coordination input', async () => {
  const h = harness();
  const {id, runner} = await liveSession(h);
  assert.equal(h.manager.deliver(id, 'block', ['M1'], true), 'steered');
  assert.equal(h.sessions.get(id)!.autoTurns, 1);
  runner.emit({type: 'input_rejected', clientId: runner.steers[0].clientId});
  assert.deepEqual(h.coordination.requeued, [['M1']]);
  assert.equal(h.items.size, 2);
  assert.ok([...h.items.values()].some(item => item.kind === 'coordination' && item.messageIds[0] === 'M1'));
});

test('steer race: a rejected user prompt is sent when the next turn opens', async () => {
  const h = harness();
  const {id, runner} = await liveSession(h);
  await h.manager.prompt(id, 'D1', 'please also');
  runner.emit({type: 'input_rejected', clientId: runner.steers[0].clientId});
  assert.equal(h.coordination.requeued.length, 0);
  runner.emit({type: 'turn_end', status: 'completed', error: null});
  assert.equal(runner.starts.length, 2);
  assert.equal(runner.starts[1].text, 'please also');
});

test('turn end requeues unconsumed coordination input', async () => {
  const h = harness();
  const {id, runner} = await liveSession(h);
  h.manager.deliver(id, 'block', ['M1', 'M2'], false);
  runner.emit({type: 'turn_end', status: 'completed', error: null});
  await tick();
  assert.deepEqual(h.coordination.requeued, [['M1', 'M2']]);
  assert.deepEqual(h.coordination.turnEnded, [[id, 'completed']]);
  assert.equal(runner.starts.length, 1);
  assert.equal(h.sessions.get(id)!.status, 'idle');
});

test('consumed coordination input is marked read and not requeued', async () => {
  const h = harness();
  const {id, runner} = await liveSession(h);
  h.manager.deliver(id, 'block', ['M1'], false);
  runner.emit({type: 'input_consumed', clientId: runner.steers[0].clientId});
  runner.emit({type: 'turn_end', status: 'completed', error: null});
  await tick();
  assert.deepEqual(h.coordination.markRead, [['M1']]);
  assert.deepEqual(h.coordination.requeued, []);
});

test('unconsumed user prompt reopens a turn on completed', async () => {
  const h = harness();
  const {id, runner} = await liveSession(h);
  await h.manager.prompt(id, 'D1', 'steered text');
  h.coordination.claim = {text: 'queued block', messageIds: ['M9']};
  runner.emit({type: 'turn_end', status: 'completed', error: null});
  await tick();
  assert.equal(runner.starts.length, 2);
  assert.equal(runner.starts[1].text, 'queued block\n\nsteered text');
  assert.equal(h.sessions.get(id)!.status, 'starting');
  assert.deepEqual(h.coordination.turnEnded, []);
});

test('unconsumed user prompt on a failed turn waits for the next prompt', async () => {
  const h = harness();
  const {id, runner} = await liveSession(h);
  await h.manager.prompt(id, 'D1', 'steered text');
  runner.emit({type: 'turn_end', status: 'failed', error: 'boom'});
  await tick();
  assert.equal(runner.starts.length, 1);
  const session = h.sessions.get(id)!;
  assert.equal(session.status, 'error');
  assert.equal(session.statusDetail, 'boom');
  assert.ok([...h.items.values()].some(item => item.kind === 'error' && item.text === 'boom'));
  assert.deepEqual(h.coordination.turnEnded, [[id, 'failed']]);

  await h.manager.prompt(id, 'D1', 'try again');
  assert.equal(runner.starts[1].text, 'steered text\n\ntry again');
});

test('generation guard: an older turn end does nothing once a new turn started', async () => {
  const h = harness();
  const {id, runner} = await liveSession(h);
  let finishScan = (_files: FileChange[]) => {};
  h.git.scan = () => new Promise(resolve => (finishScan = resolve));

  runner.emit({type: 'turn_end', status: 'completed', error: null});
  await tick();
  assert.equal(h.sessions.get(id)!.status, 'running');

  h.git.scan = () => Promise.resolve([]);
  await h.manager.prompt(id, 'D1', 'next');
  assert.equal(runner.starts.length, 2);
  runner.emit({type: 'turn_started'});

  finishScan([]);
  await tick();
  assert.equal(h.sessions.get(id)!.status, 'running');
  assert.deepEqual(h.coordination.turnEnded, []);
  assert.equal(h.coordination.filesChanged, 1);
});

test('coordination during the turn-end scan stays queued', async () => {
  const h = harness();
  const {id, runner} = await liveSession(h);
  let finishScan = (_files: FileChange[]) => {};
  h.git.scan = () => new Promise(resolve => (finishScan = resolve));
  runner.emit({type: 'turn_end', status: 'completed', error: null});
  await tick();
  assert.equal(h.manager.deliver(id, 'block', ['M1'], true), 'queued');
  assert.equal(runner.starts.length, 1);
  finishScan([]);
  await tick();
  assert.equal(h.sessions.get(id)!.status, 'idle');
});

test('native id is persisted only after the first consumption', async () => {
  const h = harness();
  const {id, runner} = await newSession(h);
  runner.emit({type: 'native_session', id: 'native-1'});
  assert.equal(h.sessions.get(id)!.nativeSessionId, null);
  runner.emit({type: 'input_consumed', clientId: runner.starts[0].clientId});
  assert.equal(h.sessions.get(id)!.nativeSessionId, 'native-1');
});

test('no native id: no wake, and the next turn carries earlier user items', async () => {
  const h = harness();
  const {id, runner} = await newSession(h, 'do the first thing');
  runner.emit({type: 'native_session', id: 'native-1'});
  runner.emit({type: 'turn_end', status: 'failed', error: 'spawn failed'});
  runner.emit({type: 'exit', error: 'spawn failed'});
  await tick();
  assert.equal(h.sessions.get(id)!.nativeSessionId, null);

  h.sessions.set(id, {...h.sessions.get(id)!, status: 'idle'});
  assert.equal(h.manager.deliver(id, 'block', ['M1'], true), 'queued');
  assert.equal(runner.starts.length, 1);

  await h.manager.prompt(id, 'D1', 'and the second');
  assert.equal(runner.starts[1].text, 'do the first thing\n\nand the second');
});

test('exit of the previous process leaves the new turn input alone', async () => {
  const h = harness();
  const {id, runner} = await liveSession(h);
  runner.emit({type: 'turn_end', status: 'completed', error: null});
  await h.manager.prompt(id, 'D1', 'next');
  assert.equal(runner.starts.length, 2);
  runner.emit({type: 'exit', error: null});
  await tick();
  assert.equal(runner.starts.length, 2);
  assert.deepEqual(h.coordination.requeued, []);
  runner.emit({type: 'input_consumed', clientId: runner.starts[1].clientId});
  runner.emit({type: 'turn_end', status: 'completed', error: null});
  await tick();
  assert.equal(runner.starts.length, 2);
});

test('budget: deliver returns over_budget and records wake_limit', async () => {
  const h = harness(1);
  const {id, runner} = await idleSession(h);

  assert.equal(h.manager.deliver(id, 'block', ['M1'], true), 'started');
  assert.equal(h.sessions.get(id)!.autoTurns, 1);
  runner.emit({type: 'turn_end', status: 'completed', error: null});
  await tick();

  assert.equal(h.manager.deliver(id, 'block', ['M2'], true), 'over_budget');
  assert.equal(h.manager.deliver(id, 'block', ['M3'], false), 'queued');
  assert.equal(runner.starts.length, 2);
  assert.equal(h.activities.filter(activity => activity.type === 'wake_limit').length, 1);
  assert.equal(h.sessions.get(id)!.autoTurns, 1);

  await h.manager.prompt(id, 'D1', 'go on');
  assert.equal(h.sessions.get(id)!.autoTurns, 0);
});

test('budget: a steer that requires action counts and is capped', async () => {
  const h = harness(1);
  const {id, runner} = await liveSession(h);
  assert.equal(h.manager.deliver(id, 'block', ['M1'], true), 'steered');
  assert.equal(h.manager.deliver(id, 'block', ['M2'], true), 'over_budget');
  assert.equal(h.manager.deliver(id, 'notice', ['M3'], false), 'steered');
  assert.equal(runner.steers.length, 2);
  assert.equal(h.sessions.get(id)!.autoTurns, 1);
});

test('sessions in error hold coordination and accept a prompt with queued messages', async () => {
  const h = harness();
  const {id, runner} = await liveSession(h);
  runner.emit({type: 'turn_end', status: 'failed', error: 'boom'});
  await tick();
  assert.equal(h.manager.deliver(id, 'block', ['M1'], true), 'queued');
  h.coordination.claim = {text: 'queued block', messageIds: ['M1']};
  await h.manager.prompt(id, 'D1', 'continue');
  assert.equal(runner.starts[1].text, 'queued block\n\ncontinue');
  const kinds = [...h.items.values()].map(item => item.kind);
  assert.ok(kinds.indexOf('coordination') < kinds.lastIndexOf('user'));
});

test('interrupt discards user input, requeues coordination and starts nothing', async () => {
  const h = harness();
  const {id, runner} = await liveSession(h);
  await h.manager.prompt(id, 'D1', 'discard me');
  h.manager.deliver(id, 'block', ['M1'], false);

  h.manager.interrupt(id);
  await tick();
  assert.equal(runner.interrupts, 1);
  assert.deepEqual(h.coordination.requeued, [['M1']]);
  assert.deepEqual(h.coordination.turnEnded, [[id, 'interrupted']]);
  assert.equal(runner.starts.length, 1);
  assert.equal(h.sessions.get(id)!.status, 'idle');

  await h.manager.prompt(id, 'D1', 'fresh');
  assert.equal(runner.starts[1].text, 'fresh');
});

test('a prompt to a done task creates and stamps a new task', async () => {
  const h = harness();
  const {id} = await idleSession(h);
  const oldTaskId = h.sessions.get(id)!.taskId!;
  h.tasks.get(oldTaskId)!.status = 'done';

  await h.manager.prompt(id, 'D1', 'new work\nwith detail');
  const session = h.sessions.get(id)!;
  assert.notEqual(session.taskId, oldTaskId);
  assert.equal(h.tasks.get(session.taskId!)!.title, 'new work');
  assert.equal(h.tasks.get(session.taskId!)!.status, 'in_progress');
  const lastUser = [...h.items.values()].filter(item => item.kind === 'user').at(-1)!;
  assert.equal(lastUser.taskId, session.taskId);
});

test('streaming: item before delta, closed on done, open rows closed at a failed end', async () => {
  const h = harness();
  const {id, runner} = await liveSession(h);
  runner.emit({type: 'text_delta', itemId: 'a:0', text: 'he'});
  runner.emit({type: 'text_delta', itemId: 'a:0', text: 'llo'});
  const forFirstBlock = h.emitted.filter(event => (event.type === 'item' ? event.item.id : event.itemId) === 'a:0');
  assert.deepEqual(forFirstBlock.map(event => event.type), ['item', 'delta', 'delta']);
  assert.equal(h.items.get('a:0')!.text, 'hello');
  assert.equal(h.items.get('a:0')!.streaming, true);
  runner.emit({type: 'text_done', itemId: 'a:0', text: 'hello'});
  assert.equal(h.items.get('a:0')!.streaming, false);
  const itemCount = h.items.size;
  runner.emit({type: 'text_done', itemId: 'a:0', text: 'hello'});
  assert.equal(h.items.size, itemCount);

  runner.emit({type: 'tool_start', itemId: 't1', name: 'Bash', category: 'shell', summary: 'ls'});
  runner.emit({type: 'tool_output', itemId: 't1', text: 'x'.repeat(30 * 1024)});
  runner.emit({type: 'text_delta', itemId: 'b:0', text: 'partial'});
  runner.emit({type: 'turn_end', status: 'failed', error: null});
  await tick();
  const tool = h.items.get('t1')!;
  assert.equal(tool.streaming, false);
  assert.equal(tool.tool!.status, 'error');
  assert.equal(tool.tool!.output.length, 20 * 1024);
  assert.equal(h.items.get('b:0')!.streaming, false);
  assert.equal(h.items.get('b:0')!.text, 'partial');
  assert.equal(h.sessions.get(id)!.statusDetail, 'Turn failed');
});

test('tool_end stores capped output and marks status', async () => {
  const h = harness();
  const {runner} = await liveSession(h);
  runner.emit({type: 'tool_start', itemId: 't1', name: 'Bash', category: 'shell', summary: 'ls'});
  runner.emit({type: 'tool_end', itemId: 't1', ok: false, output: `${'y'.repeat(30 * 1024)}end`});
  const tool = h.items.get('t1')!.tool!;
  assert.equal(tool.status, 'error');
  assert.equal(tool.output.length, 20 * 1024);
  assert.ok(tool.output.endsWith('end'));
  assert.equal(h.items.get('t1')!.streaming, false);
  await h.manager.shutdown();
});
