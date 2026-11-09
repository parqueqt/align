import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, test} from 'node:test';
import {createBus} from '../server/bus.ts';
import type {App, Config, SessionRow} from '../server/contracts.ts';
import {createStore} from '../server/store.ts';

let dir: string;
let config: Config;
let store: ReturnType<typeof createStore>;

function testConfig(home: string): Config {
  return {
    home,
    dbPath: path.join(home, 'align.db'),
    worktreesDir: path.join(home, 'worktrees'),
    gbrainHome: path.join(home, 'gbrain'),
    port: 0,
    bunBin: null,
    gbrainCli: null,
    claudeBin: null,
    codexBin: null,
    claudeModel: null,
    codexModel: null,
    codexEffort: 'medium',
    maxAutoTurns: 8,
  };
}

function addSession(developerName = 'Alice', agent: 'claude' | 'codex' = 'claude'): SessionRow {
  const developer = store.upsertDeveloper(developerName);
  const handle = store.allocateHandle(developer.id, agent);
  return store.createSession({
    handle,
    developerId: developer.id,
    agent,
    title: 'Work',
    branch: `align/${handle}`,
    worktreePath: path.join(dir, handle),
    baseSha: 'abc',
    mcpToken: `token-${handle}`,
  });
}

function addImpact(sessionId: string, taskId: string, sourceKey = 'api') {
  return store.createImpact({source: 'decision', sourceKey, fromVersion: 1, toVersion: 2, actorSessionId: null, taskId, sessionId});
}

function addMessage(toSessionId: string, requiresAction = false) {
  return store.createMessage({fromSessionId: null, toSessionId, kind: 'notice', subject: 's', body: 'b', requiresAction});
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'align-store-'));
  config = testConfig(dir);
  store = createStore(config);
});

afterEach(() => {
  store.close();
  rmSync(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
});

test('uses per-prefix id counters that survive a restart', () => {
  const session = addSession();
  const other = addSession('Bob', 'codex');
  const task = store.createTask({title: 't', description: '', status: 'planned', sessionId: session.id});
  const message = addMessage(session.id);
  const impact = addImpact(session.id, task.id);
  assert.deepEqual([session.id, other.id, task.id, message.id, impact.id], ['S1', 'S2', 'T1', 'M1', 'I1']);
  assert.equal(session.developerId, 'D1');
  assert.equal(other.developerId, 'D2');

  store.close();
  store = createStore(config);
  assert.equal(store.createTask({title: 't2', description: '', status: 'planned', sessionId: session.id}).id, 'T2');
});

test('setProject keeps the id for the same repo and replaces it for another', () => {
  assert.equal(store.getProject(), null);
  const first = store.setProject({name: 'a', repoPath: '/a', baseBranch: 'main'});
  assert.equal(store.setProject({name: 'a', repoPath: '/a', baseBranch: 'dev'}).id, first.id);
  assert.equal(store.getProject()?.baseBranch, 'dev');

  store.upsertMemory({
    key: 'k',
    kind: 'decision',
    title: 't',
    body: 'b',
    version: 1,
    gbrainSlug: 's',
    authorSessionId: null,
    updatedAt: 1,
    gbrainRevision: 'r',
    gbrainUpdatedAt: 'u',
  });
  const second = store.setProject({name: 'b', repoPath: '/b', baseBranch: 'main'});
  assert.notEqual(second.id, first.id);
  assert.deepEqual(store.listMemory(), []);
});

test('developers are idempotent by case-insensitive name and get palette colors', () => {
  const alice = store.upsertDeveloper('Alice');
  const again = store.upsertDeveloper('  aLiCe ');
  const bob = store.upsertDeveloper('Bob');
  assert.equal(again.id, alice.id);
  assert.equal(again.name, 'Alice');
  assert.notEqual(bob.color, alice.color);
  assert.match(alice.color, /^#[0-9A-F]{6}$/);
  assert.deepEqual(store.getDeveloper(alice.id), {...alice, online: false});
  assert.deepEqual(store.listDevelopers().map((d) => d.id), [alice.id, bob.id]);
  assert.equal('online' in store.listDevelopers()[0]!, false);
  assert.equal(store.getDeveloper('D99'), null);
});

test('handles are reserved until createSession, stay unique, and always match the pattern', () => {
  const alice = store.upsertDeveloper('Alice Smith!');
  assert.equal(store.allocateHandle(alice.id, 'claude'), 'alice-smith-claude');
  assert.equal(store.allocateHandle(alice.id, 'claude'), 'alice-smith-claude-2');
  assert.equal(store.allocateHandle(alice.id, 'codex'), 'alice-smith-codex');

  store.close();
  store = createStore(config);
  assert.equal(store.allocateHandle(alice.id, 'claude'), 'alice-smith-claude-3');

  const noLetters = store.upsertDeveloper('李雷');
  assert.equal(store.allocateHandle(noLetters.id, 'codex'), `${noLetters.id.toLowerCase()}-codex`);
  const digits = store.upsertDeveloper('1234');
  assert.equal(store.allocateHandle(digits.id, 'claude'), `${digits.id.toLowerCase()}-claude`);
  const accented = store.upsertDeveloper('José');
  assert.equal(store.allocateHandle(accented.id, 'claude'), 'jose-claude');

  const long = store.allocateHandle(store.upsertDeveloper('x'.repeat(200)).id, 'claude');
  assert.match(long, /^[a-z0-9-]+$/);
  assert.ok(long.length < 40);
});

test('a created session keeps its handle unavailable', () => {
  const session = addSession();
  assert.equal(session.handle, 'alice-claude');
  assert.equal(store.allocateHandle(session.developerId, 'claude'), 'alice-claude-2');
});

test('sessions resolve by id, handle and token', () => {
  const session = addSession();
  assert.equal(session.status, 'idle');
  assert.equal(session.autoTurns, 0);
  assert.equal(session.runnerPid, null);
  assert.equal(store.getSessionByToken('token-alice-claude')?.id, session.id);
  assert.equal(store.resolveSession(session.id)?.id, session.id);
  assert.equal(store.resolveSession(session.handle)?.id, session.id);
  assert.equal(store.resolveSession('nope'), null);
  assert.equal(store.getSessionByToken('nope'), null);
});

test('updateSession skips undefined keys and null clears a column', () => {
  const session = addSession();
  store.updateSession(session.id, {statusDetail: 'boom', runnerPid: 42, status: 'error'});
  const patched = store.updateSession(session.id, {statusDetail: undefined, runnerPid: null, status: undefined, autoTurns: 3});
  assert.equal(patched.statusDetail, 'boom');
  assert.equal(patched.status, 'error');
  assert.equal(patched.runnerPid, null);
  assert.equal(patched.autoTurns, 3);
  assert.throws(() => store.updateSession('S99', {status: 'idle'}), /not found/);
});

test('items get per-session seq, default task stamp, and survive boolean and JSON round trips', () => {
  const session = addSession();
  const other = addSession('Bob');
  const task = store.createTask({title: 't', description: '', status: 'in_progress', sessionId: session.id});
  store.updateSession(session.id, {taskId: task.id});

  const first = store.addItem({sessionId: session.id, kind: 'user', text: 'hi', developerId: session.developerId});
  const second = store.addItem({
    id: 'msg:0',
    sessionId: session.id,
    kind: 'tool',
    text: '',
    streaming: true,
    tool: {name: 'Bash', category: 'shell', summary: 'ls', output: '', status: 'running'},
    messageIds: ['M1'],
    taskId: null,
  });
  const foreign = store.addItem({sessionId: other.id, kind: 'assistant', text: 'x'});

  assert.deepEqual([first.seq, second.seq, foreign.seq], [1, 2, 1]);
  assert.equal(first.taskId, task.id);
  assert.equal(second.taskId, null);
  assert.equal(first.streaming, false);
  assert.equal(first.tool, null);
  assert.deepEqual(first.messageIds, []);
  assert.equal(second.id, 'msg:0');
  assert.equal(second.streaming, true);
  assert.deepEqual(second.messageIds, ['M1']);

  const updated = store.updateItem('msg:0', {text: undefined, streaming: false});
  assert.equal(updated.streaming, false);
  assert.equal(updated.text, '');
  assert.deepEqual(store.listItems(session.id).map((i) => i.seq), [1, 2]);
  assert.equal(store.getItem('missing'), null);
});

test('closeOpenItems ends streaming and fails running tools only', () => {
  const session = addSession();
  const tool = {name: 'Bash', category: 'shell' as const, summary: 'ls', output: 'out', status: 'running' as const};
  store.addItem({id: 'a', sessionId: session.id, kind: 'tool', text: '', streaming: true, tool});
  store.addItem({id: 'b', sessionId: session.id, kind: 'tool', text: '', tool: {...tool, status: 'ok'}});
  store.addItem({id: 'c', sessionId: session.id, kind: 'assistant', text: 'partial', streaming: true});

  store.closeOpenItems();

  assert.equal(store.getItem('a')?.streaming, false);
  assert.deepEqual(store.getItem('a')?.tool, {...tool, status: 'error'});
  assert.equal(store.getItem('b')?.tool?.status, 'ok');
  assert.equal(store.getItem('c')?.streaming, false);
  assert.equal(store.getItem('c')?.text, 'partial');
});

test('tasks carry session fields, dependencies and decision links', () => {
  const session = addSession();
  const other = addSession('Bob', 'codex');
  const a = store.createTask({title: 'a', description: 'd', status: 'planned', sessionId: session.id});
  const b = store.createTask({title: 'b', description: '', status: 'in_progress', sessionId: other.id});

  assert.equal(a.developerId, session.developerId);
  assert.equal(a.agent, 'claude');
  assert.equal(a.branch, session.branch);
  assert.equal(a.worktreePath, session.worktreePath);
  assert.deepEqual(a.files, []);
  assert.deepEqual(a.dependsOn, []);
  assert.deepEqual(a.decisions, []);

  const updated = store.updateTask(a.id, {status: 'done', files: ['src/a.ts'], title: undefined});
  assert.equal(updated.title, 'a');
  assert.equal(updated.status, 'done');
  assert.deepEqual(updated.files, ['src/a.ts']);

  store.addTaskDependency(b.id, a.id);
  store.addTaskDependency(b.id, a.id);
  assert.deepEqual(store.getTask(b.id)?.dependsOn, [a.id]);
  assert.deepEqual(store.listDependents(a.id).map((t) => t.id), [b.id]);
  assert.deepEqual(store.listDependents(b.id), []);

  store.linkTaskDecision(a.id, 'api', 0);
  store.linkTaskDecision(a.id, 'api', 3);
  store.linkTaskDecision(a.id, 'api', 1);
  assert.deepEqual(store.getTask(a.id)?.decisions, [{key: 'api', ackedVersion: 3}]);
  assert.deepEqual(store.listTasksUsingDecision('api').map((t) => t.id), [a.id]);
  assert.deepEqual(store.listTasks().map((t) => t.id), [a.id, b.id]);
  assert.throws(() => store.createTask({title: 'x', description: '', status: 'planned', sessionId: 'S99'}), /not found/);
});

test('memory mirrors entries, versions and sync state', () => {
  const stored = {
    key: 'api',
    kind: 'decision' as const,
    title: 'API',
    body: 'v1',
    version: 1,
    gbrainSlug: 'align/p1/decision/api',
    authorSessionId: null,
    updatedAt: 1,
    gbrainRevision: 'r1',
    gbrainUpdatedAt: 'then',
  };
  store.upsertMemory(stored);
  store.upsertMemory({...stored, body: 'v2', version: 2});
  store.setMemorySync('api', 'r2', 'now');

  assert.deepEqual(store.getMemory('api'), {...stored, body: 'v2', version: 2, gbrainRevision: 'r2', gbrainUpdatedAt: 'now'});
  const [listed] = store.listMemory();
  assert.equal(listed?.version, 2);
  assert.equal('gbrainRevision' in listed!, false);
  assert.equal(store.getMemory('missing'), null);

  store.addMemoryVersion({key: 'api', version: 1, title: 'API', body: 'v1', authorSessionId: null, createdAt: 1});
  assert.equal(store.getMemoryVersion('api', 1)?.body, 'v1');
  assert.equal(store.getMemoryVersion('api', 9), null);
});

test('messages keep booleans and ordering', () => {
  const session = addSession();
  const other = addSession('Bob');
  const first = addMessage(session.id, true);
  const second = addMessage(session.id, false);
  addMessage(other.id);

  assert.equal(first.requiresAction, true);
  assert.equal(second.requiresAction, false);
  assert.equal(first.state, 'queued');
  assert.equal(first.replyToId, null);

  assert.deepEqual(store.listMessagesForSession(session.id).map((m) => m.id), [first.id, second.id]);
  assert.deepEqual(store.listMessages().map((m) => m.id), ['M3', 'M2', 'M1']);
  assert.deepEqual(store.listMessages(2).map((m) => m.id), ['M3', 'M2']);

  store.updateMessage(first.id, {state: 'delivered', deliveredAt: 5, readAt: undefined});
  assert.deepEqual(store.listMessagesForSession(session.id, ['delivered']).map((m) => m.id), [first.id]);
  assert.deepEqual(store.listMessagesForSession(session.id, ['delivered', 'queued']).map((m) => m.id), [first.id, second.id]);
  assert.deepEqual(store.listMessagesForSession(session.id, []), []);
  assert.equal(store.getMessage(first.id)?.deliveredAt, 5);
  assert.equal(store.getMessage(first.id)?.readAt, null);
});

test('open impacts honor the default and explicit states', () => {
  const session = addSession();
  const task = store.createTask({title: 't', description: '', status: 'in_progress', sessionId: session.id});
  const a = addImpact(session.id, task.id, 'one');
  const b = addImpact(session.id, task.id, 'two');
  const c = addImpact(session.id, task.id, 'three');
  assert.equal(a.state, 'pending');
  assert.equal(a.reminders, 0);

  store.updateImpact(b.id, {state: 'adapted', commitSha: 'sha', resolvedAt: 9, note: undefined});
  store.updateImpact(c.id, {state: 'acknowledged'});

  assert.deepEqual(store.listOpenImpacts(session.id).map((i) => i.id), [a.id, c.id]);
  assert.deepEqual(store.listOpenImpacts(session.id, ['adapted']).map((i) => i.id), [b.id]);
  assert.equal(store.findOpenImpact(task.id, 'decision', 'one')?.id, a.id);
  assert.equal(store.findOpenImpact(task.id, 'decision', 'two'), null);
  assert.equal(store.findOpenImpact(task.id, 'task', 'one'), null);
  assert.deepEqual(store.listImpacts(1).map((i) => i.id), [c.id]);
  assert.equal(store.getImpact(b.id)?.commitSha, 'sha');
  assert.equal(store.getImpact(b.id)?.note, '');
});

test('replaceFiles replaces only that session and round-trips committed', () => {
  const session = addSession();
  const other = addSession('Bob');
  const change = (sessionId: string, file: string, committed: boolean) => ({sessionId, path: file, state: 'modified' as const, additions: 1, deletions: 2, committed});
  store.replaceFiles(session.id, [change(session.id, 'a.ts', true), change(session.id, 'b.ts', false)]);
  store.replaceFiles(other.id, [change(other.id, 'c.ts', true)]);
  store.replaceFiles(session.id, [change(session.id, 'b.ts', false)]);

  assert.deepEqual(store.listFiles(), [change(session.id, 'b.ts', false), change(other.id, 'c.ts', true)]);
});

test('markOverlapSeen is true once per file and unordered pair', () => {
  assert.equal(store.markOverlapSeen('a.ts', 'S1', 'S2'), true);
  assert.equal(store.markOverlapSeen('a.ts', 'S2', 'S1'), false);
  assert.equal(store.markOverlapSeen('b.ts', 'S1', 'S2'), true);
  assert.equal(store.markOverlapSeen('a.ts', 'S1', 'S3'), true);
});

test('activity lists newest first and finds commits strictly after a time', async () => {
  const first = store.addActivity({type: 'commit', actorSessionId: 'S1', subject: 'sha1', data: {files: 1}});
  store.addActivity({type: 'task_done', actorSessionId: 'S1'});
  store.addActivity({type: 'commit', actorSessionId: 'S2', subject: 'other'});

  assert.deepEqual(first.data, {files: 1});
  assert.equal(first.targetSessionId, null);
  const listed = store.listActivity();
  assert.deepEqual(listed.map((a) => a.id), [first.id + 2, first.id + 1, first.id]);
  assert.equal(listed[1]?.subject, '');
  assert.deepEqual(listed[1]?.data, {});
  assert.equal(store.listActivity(1).length, 1);

  assert.equal(store.latestCommitSince('S1', first.createdAt - 1)?.subject, 'sha1');
  assert.equal(store.latestCommitSince('S1', first.createdAt), null);
  assert.equal(store.latestCommitSince('S9', 0), null);

  await new Promise((resolve) => setTimeout(resolve, 2));
  const later = store.addActivity({type: 'commit', actorSessionId: 'S1', subject: 'sha2'});
  assert.equal(store.latestCommitSince('S1', first.createdAt)?.id, later.id);
});

function busApp(): App {
  return {store, coordination: {deriveIssues: () => []}} as unknown as App;
}

test('snapshots strip session secrets, cap activity and report presence with refcounts', () => {
  const session = addSession();
  store.updateSession(session.id, {runnerPid: 123});
  for (let i = 0; i < 205; i++) store.addActivity({type: 'commit', subject: String(i)});

  const bus = createBus(busApp());
  const received: unknown[] = [];
  const leaveA = bus.connect(session.developerId, (event) => received.push(event));
  const leaveB = bus.connect(session.developerId, () => {});

  const snapshot = bus.snapshot();
  assert.equal(snapshot.activity.length, 200);
  assert.equal(snapshot.activity[0]?.subject, '204');
  assert.equal('mcpToken' in snapshot.sessions[0]!, false);
  assert.equal('runnerPid' in snapshot.sessions[0]!, false);
  assert.equal(JSON.stringify(snapshot).includes(session.mcpToken), false);
  assert.equal(snapshot.developers[0]?.online, true);
  assert.equal((received[0] as {type: string}).type, 'snapshot');

  leaveA();
  leaveA();
  assert.equal(bus.snapshot().developers[0]?.online, true);
  leaveB();
  assert.equal(bus.snapshot().developers[0]?.online, false);
});

test('touch coalesces broadcasts and emit is immediate', async () => {
  const bus = createBus(busApp());
  const types: string[] = [];
  const leave = bus.connect(null, (event) => types.push(event.type));
  await new Promise((resolve) => setTimeout(resolve, 200));
  types.length = 0;

  bus.emit({type: 'delta', sessionId: 'S1', itemId: 'x', text: 'y'});
  assert.deepEqual(types, ['delta']);
  types.length = 0;

  for (let i = 0; i < 20; i++) bus.touch();
  await new Promise((resolve) => setTimeout(resolve, 60));
  bus.touch();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(types.length >= 1 && types.length <= 2, `got ${types.length} broadcasts`);
  assert.ok(types.every((type) => type === 'snapshot'));
  leave();
});
