import path from 'node:path';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {z} from 'zod';
import type {AgentMessage, Task} from '../shared/types.ts';
import type {App, McpHandler, SessionRow} from './contracts.ts';
import {normalizeKey} from './memory.ts';

const data = (value: unknown): CallToolResult => ({content: [{type: 'text', text: JSON.stringify(value)}]});
const failure = (value: unknown): CallToolResult => ({content: [{type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value)}], isError: true});

function guarded<A>(handler: (args: A) => CallToolResult | Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await handler(args);
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
  };
}

function normalizeFiles(files: string[], worktree: string): string[] {
  const normalized = new Set<string>();
  for (const file of files) {
    const relative = path.relative(worktree, path.resolve(worktree, file.trim()));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`File is outside this worktree: ${file}`);
    }
    normalized.add(relative.split(path.sep).join('/'));
  }
  return [...normalized];
}

function handleOf(app: App, sessionId: string | null): string | null {
  return sessionId ? (app.store.getSession(sessionId)?.handle ?? sessionId) : null;
}

function developerName(app: App, developerId: string): string {
  return app.store.getDeveloper(developerId)?.name ?? developerId;
}

function taskView(app: App, task: Task) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    note: task.note,
    owner: handleOf(app, task.sessionId),
    developer: developerName(app, task.developerId),
    agent: task.agent,
    branch: task.branch,
    worktree: task.worktreePath,
    files: task.files,
    dependsOn: task.dependsOn,
    decisions: task.decisions,
  };
}

function messageView(app: App, message: AgentMessage) {
  return {
    id: message.id,
    from: handleOf(app, message.fromSessionId),
    kind: message.kind,
    subject: message.subject,
    body: message.body,
    replyTo: message.replyToId,
    taskId: message.taskId,
    decisionKey: message.decisionKey,
    impactId: message.impactId,
    requiresAction: message.requiresAction,
    state: message.state,
    createdAt: message.createdAt,
  };
}

function applyTaskLinks(app: App, task: Task, dependsOn: string[] | undefined, usesDecisions: string[] | undefined): void {
  for (const id of dependsOn ?? []) {
    if (id === task.id) throw new Error(`Task ${id} cannot depend on itself`);
    if (!app.store.getTask(id)) throw new Error(`Unknown task ${id}`);
  }
  const keys = (usesDecisions ?? []).map(normalizeKey);
  for (const id of dependsOn ?? []) app.store.addTaskDependency(task.id, id);
  for (const key of keys) {
    // Declaring must not raise an existing link: only reading a decision acknowledges a newer version.
    if (task.decisions.some(link => link.key === key)) continue;
    app.store.linkTaskDecision(task.id, key, app.store.getMemory(key)?.version ?? 0);
  }
}

function registerTools(server: McpServer, app: App, sessionId: string): void {
  const self = (): SessionRow => {
    const session = app.store.getSession(sessionId);
    if (!session) throw new Error('This session no longer exists');
    return session;
  };
  const authorName = (session: SessionRow) => `${developerName(app, session.developerId)} (${session.agent})`;

  /** Native terminals cannot be pushed to, so agents pull: claiming marks queued messages delivered and read. */
  function pull(session: SessionRow): AgentMessage[] {
    const claimed = app.coordination.claimQueued(session.id)?.messageIds ?? [];
    const delivered = app.store.listMessagesForSession(session.id, ['delivered']).map(message => message.id);
    const ids = [...new Set([...claimed, ...delivered])];
    if (ids.length > 0) app.coordination.markRead(ids);
    return ids.map(id => app.store.getMessage(id)!).filter(Boolean);
  }

  function awaitingReply(session: SessionRow) {
    return app.store.listMessagesForSession(session.id, ['read'])
      .filter(message => message.requiresAction && (message.kind === 'question' || message.kind === 'request'))
      .map(message => ({id: message.id, from: handleOf(app, message.fromSessionId), subject: message.subject}));
  }

  async function recordCommit(session: SessionRow, sha: string, files: string[]): Promise<void> {
    app.store.addActivity({type: 'commit', actorSessionId: session.id, taskId: session.taskId, subject: sha, data: {sha, files}});
    app.store.updateSession(session.id, {headSha: sha});
    try {
      app.store.replaceFiles(session.id, await app.git.listChanges(session.worktreePath, session.baseSha, session.id));
      app.coordination.onFilesChanged(session.id);
    } catch (error) {
      // The commit stands; the next scan catches up.
      console.error('file scan after commit failed:', error);
    }
    app.bus.touch();
  }

  server.registerTool('sync', {description: 'Your task, open impacts, inbox, peers, and the decisions index.', inputSchema: {}}, guarded(() => {
    const session = self();
    const task = session.taskId ? app.store.getTask(session.taskId) : null;
    return data({
      you: {handle: session.handle, agent: session.agent, developer: developerName(app, session.developerId), branch: session.branch},
      task: task && taskView(app, task),
      impacts: app.store.listOpenImpacts(session.id),
      newMessages: pull(session).map(message => messageView(app, message)),
      awaitingYourReply: awaitingReply(session),
      peers: app.store.listSessions().filter(peer => peer.id !== session.id).map(peer => {
        const peerTask = peer.taskId ? app.store.getTask(peer.taskId) : null;
        return {
          handle: peer.handle,
          developer: developerName(app, peer.developerId),
          agent: peer.agent,
          active: Date.now() - peer.lastActiveAt < 180_000,
          task: peerTask && {id: peerTask.id, title: peerTask.title, status: peerTask.status, note: peerTask.note, files: peerTask.files},
          branch: peer.branch,
        };
      }),
      decisions: app.store.listMemory().map(entry => ({key: entry.key, kind: entry.kind, title: entry.title, version: entry.version})),
    });
  }));

  server.registerTool('task_list', {description: 'All tasks with owners, status, branches, files and dependencies.', inputSchema: {}}, guarded(() =>
    data(app.store.listTasks().map(task => taskView(app, task)))));

  server.registerTool('task_update', {
    description: 'Update your task. Defaults to the current task. status "done" requires committed work and no open impacts.',
    inputSchema: {
      title: z.string().min(1).optional(),
      description: z.string().optional(),
      status: z.enum(['planned', 'in_progress', 'blocked', 'done']).optional(),
      note: z.string().optional(),
      files: z.array(z.string().min(1)).optional(),
      depends_on: z.array(z.string().min(1)).optional(),
      uses_decisions: z.array(z.string().min(1)).optional(),
      interface_change: z.string().min(1).optional(),
      task_id: z.string().min(1).optional(),
    },
  }, guarded(async args => {
    const session = self();
    const taskId = args.task_id ?? session.taskId;
    const task = taskId ? app.store.getTask(taskId) : null;
    if (!task) throw new Error(`Unknown task ${taskId ?? ''}`.trim());
    if (task.sessionId !== session.id) throw new Error(`Task ${task.id} belongs to another session`);

    const files = args.files && normalizeFiles(args.files, session.worktreePath);
    if (args.status === 'done' && task.status !== 'done') {
      const gate = await app.coordination.completionGate(task.id);
      if (!gate.ok) {
        const impacts = gate.openImpacts.map(impact => `${impact.id} (${impact.sourceKey}, ${impact.state})`);
        return failure(`Task ${task.id} cannot be done. Open impacts: ${impacts.join(', ') || 'none'}. Uncommitted files: ${gate.uncommitted.join(', ') || 'none'}.`);
      }
    }

    const previous = app.store.getTask(task.id)!;
    applyTaskLinks(app, previous, args.depends_on, args.uses_decisions);
    const updated = app.store.updateTask(task.id, {title: args.title, description: args.description, status: args.status, note: args.note, files});
    app.store.addActivity({type: 'task_updated', actorSessionId: session.id, taskId: task.id, subject: updated.title, data: {status: updated.status}});
    app.coordination.onTaskChanged(updated, previous, args.interface_change ?? null);
    if (files) app.coordination.onFilesChanged(session.id);
    app.bus.touch();
    return data(taskView(app, app.store.getTask(task.id)!));
  }));

  server.registerTool('task_register', {
    description: 'Add a task owned by this session and make it current.',
    inputSchema: {
      title: z.string().min(1),
      description: z.string().optional(),
      files: z.array(z.string().min(1)).optional(),
      depends_on: z.array(z.string().min(1)).optional(),
      uses_decisions: z.array(z.string().min(1)).optional(),
    },
  }, guarded(args => {
    const session = self();
    const files = args.files && normalizeFiles(args.files, session.worktreePath);
    for (const id of args.depends_on ?? []) if (!app.store.getTask(id)) throw new Error(`Unknown task ${id}`);
    (args.uses_decisions ?? []).forEach(normalizeKey);

    const task = app.store.createTask({title: args.title, description: args.description ?? '', status: 'in_progress', sessionId: session.id});
    if (files) app.store.updateTask(task.id, {files});
    applyTaskLinks(app, task, args.depends_on, args.uses_decisions);
    app.store.updateSession(session.id, {taskId: task.id});
    app.store.addActivity({type: 'task_registered', actorSessionId: session.id, taskId: task.id, subject: task.title});
    if (files) app.coordination.onFilesChanged(session.id);
    app.bus.touch();
    return data(taskView(app, app.store.getTask(task.id)!));
  }));

  server.registerTool('memory_search', {description: 'Search shared project knowledge in GBrain.', inputSchema: {query: z.string().min(1)}}, guarded(async args =>
    data(await app.memory.search(args.query))));

  server.registerTool('memory_get', {description: 'Read a shared decision and its previous version. Links your current task to it.', inputSchema: {key: z.string().min(1)}}, guarded(async args => {
    const read = await app.memory.get(self(), args.key);
    if (!read) throw new Error(`No memory entry for key "${args.key}"`);
    const {entry, previous} = read;
    const reader = self();
    app.store.addActivity({type: 'memory_read', actorSessionId: reader.id, taskId: reader.taskId, subject: entry.key, data: {version: entry.version}});
    app.bus.touch();
    return data({
      key: entry.key,
      kind: entry.kind,
      title: entry.title,
      version: entry.version,
      body: entry.body,
      author: handleOf(app, entry.authorSessionId),
      updatedAt: entry.updatedAt,
      previous: previous && {version: previous.version, title: previous.title, body: previous.body},
    });
  }));

  server.registerTool('memory_publish', {
    description: 'Publish shared knowledge. Changing an existing key requires expected_version.',
    inputSchema: {
      key: z.string().min(1),
      kind: z.enum(['decision', 'convention', 'rule', 'context']),
      title: z.string().min(1),
      body: z.string().min(1),
      expected_version: z.number().int().nonnegative().optional(),
    },
  }, guarded(async args => {
    const result = await app.memory.publish(self(), {key: args.key, kind: args.kind, title: args.title, body: args.body, expectedVersion: args.expected_version});
    if (result.status === 'version_conflict') return failure({status: result.status, entry: result.entry});
    return data({status: result.status, key: result.entry.key, version: result.entry.version});
  }));

  async function publishDecision(session: SessionRow, key: string, title: string, body: string) {
    const current = app.store.getMemory(normalizeKey(key));
    const result = await app.memory.publish(session, {key, kind: 'decision', title, body, expectedVersion: current?.version});
    if (result.status === 'version_conflict') throw new Error(`Decision ${key} changed meanwhile (now v${result.entry.version}); retry`);
    return result.entry;
  }

  function tellPeers(session: SessionRow, subject: string, body: string, requiresAction: boolean, skip: Set<string> = new Set()) {
    for (const peer of app.store.listSessions()) {
      if (peer.id === session.id || skip.has(peer.id)) continue;
      app.coordination.sendMessage(session, {to: peer.id, kind: 'notice', subject, body, requiresAction});
    }
  }

  server.registerTool('decision_request', {
    description: 'Record that a decision needs your developer (product/design choice, conflicting requirements, risky change). Marks it pending in shared memory and tells the other agents. Then ask your developer in your terminal.',
    inputSchema: {
      key: z.string().min(1),
      question: z.string().min(1),
      options: z.array(z.string().min(1)).optional(),
    },
  }, guarded(async args => {
    const session = self();
    const developer = developerName(app, session.developerId);
    const options = (args.options ?? []).map((option, i) => `${i + 1}. ${option}`).join('\n');
    const entry = await publishDecision(session, args.key, `PENDING (${developer}): ${args.question}`,
      `Status: pending human decision\nOwner: ${developer} (asked by ${session.handle})\n\n${args.question}${options ? `\n\nOptions:\n${options}` : ''}`);
    app.store.addActivity({type: 'decision_requested', actorSessionId: session.id, taskId: session.taskId, subject: entry.key, data: {question: args.question, developer}});
    tellPeers(session, `Pending human decision: ${entry.key}`, `${developer} must decide: ${args.question}${options ? `\nOptions:\n${options}` : ''}\nDo not implement behaviour that depends on this until it is decided; you will be notified. Work on everything else.`, false);
    app.bus.touch();
    return data({key: entry.key, version: entry.version, status: 'pending', ask: developer});
  }));

  server.registerTool('decision_record', {
    description: "Record your developer's answer to a pending decision. Stores it in shared memory as approved and notifies affected agents.",
    inputSchema: {
      key: z.string().min(1),
      decision: z.string().min(1).describe('The decision, stated precisely enough to implement.'),
      developer_said: z.string().min(1).describe("Your developer's answer, in their own words."),
    },
  }, guarded(async args => {
    const session = self();
    const developer = developerName(app, session.developerId);
    const key = normalizeKey(args.key);
    if (!app.store.getMemory(key)) throw new Error(`No pending decision ${key}: call decision_request first`);
    const entry = await publishDecision(session, key, `APPROVED by ${developer}: ${args.decision}`.slice(0, 200),
      `Status: approved by ${developer} (human), recorded by ${session.handle}\n\nDecision: ${args.decision}\n\n${developer} said: "${args.developer_said}"`);
    app.store.addActivity({type: 'decision_recorded', actorSessionId: session.id, taskId: session.taskId, subject: entry.key, data: {version: entry.version, developer, decision: args.decision}});
    // Agents linked to the decision already received a decision_change; tell everyone else too.
    const impacted = new Set(app.store.listImpacts().filter(impact => impact.sourceKey === key && impact.toVersion === entry.version).map(impact => impact.sessionId));
    tellPeers(session, `Decision approved: ${key}`, `${developer} decided: ${args.decision}\nRead it with memory_get "${key}" and implement accordingly.`, true, impacted);
    app.bus.touch();
    return data({key: entry.key, version: entry.version, status: 'approved', by: developer});
  }));

  server.registerTool('message_send', {
    description: 'Send a message to another agent by handle, session id, or task id.',
    inputSchema: {
      to: z.string().min(1),
      kind: z.enum(['question', 'answer', 'request', 'response', 'notice']),
      subject: z.string().min(1),
      body: z.string().min(1),
      reply_to: z.string().min(1).optional(),
      requires_action: z.boolean().optional(),
    },
  }, guarded(args => {
    const message = app.coordination.sendMessage(self(), {
      to: args.to,
      kind: args.kind,
      subject: args.subject,
      body: args.body,
      replyToId: args.reply_to,
      requiresAction: args.requires_action,
    });
    return data({id: message.id, to: handleOf(app, message.toSessionId), state: message.state});
  }));

  server.registerTool('inbox', {description: 'Receive new messages from other agents. Call after every few steps.', inputSchema: {}}, guarded(() => {
    const session = self();
    return data({newMessages: pull(session).map(message => messageView(app, message)), awaitingYourReply: awaitingReply(session)});
  }));

  server.registerTool('message_wait', {
    description: 'Wait for new messages (for example the answer to your question). Returns as soon as one arrives.',
    inputSchema: {
      reply_to: z.string().min(1).optional().describe('Keep waiting until a reply to this message id arrives.'),
      timeout_seconds: z.number().int().min(1).max(280).optional(),
    },
  }, guarded(async args => {
    const session = self();
    const deadline = Date.now() + (args.timeout_seconds ?? 240) * 1000;
    const received: AgentMessage[] = [];
    for (;;) {
      received.push(...pull(session));
      const done = args.reply_to ? received.some(message => message.replyToId === args.reply_to) : received.length > 0;
      if (done || Date.now() >= deadline) {
        return data({newMessages: received.map(message => messageView(app, message)), timedOut: !done, awaitingYourReply: awaitingReply(session)});
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }));

  server.registerTool('message_list', {description: 'Full message history of this session.', inputSchema: {}}, guarded(() => {
    const session = self();
    pull(session);
    return data(app.store.listMessagesForSession(session.id).map(message => messageView(app, message)));
  }));

  server.registerTool('impact_ack', {
    description: 'Record your response to an impact.',
    inputSchema: {
      impact_id: z.string().min(1),
      outcome: z.enum(['acknowledged', 'adapted', 'no_change', 'conflict']),
      note: z.string().optional(),
    },
  }, guarded(args => {
    const impact = app.coordination.ackImpact(self(), args.impact_id, args.outcome, args.note ?? '');
    return data({id: impact.id, state: impact.state, commitSha: impact.commitSha});
  }));

  server.registerTool('commit', {description: 'Stage and commit everything in this worktree.', inputSchema: {message: z.string().min(1)}}, guarded(async args => {
    const session = self();
    const result = await app.git.commit(session.worktreePath, args.message, authorName(session));
    if (!result) return data({status: 'nothing_to_commit'});
    await recordCommit(session, result.sha, result.files);
    return data(result);
  }));

  server.registerTool('merge', {description: 'Merge a peer branch or the base branch into this worktree. On conflict, aborts and returns the paths.', inputSchema: {branch: z.string().min(1)}}, guarded(async args => {
    const session = self();
    const known = app.store.getProject()?.baseBranch === args.branch || app.store.listSessions().some(peer => peer.id !== session.id && peer.branch === args.branch);
    if (!known) throw new Error(`Unknown branch "${args.branch}": use a peer's branch or the project's base branch`);
    const result = await app.git.merge(session.worktreePath, args.branch, authorName(session));
    if (result.status === 'conflict') return failure(result);
    if (result.status === 'merged') {
      // Files taken from the peer by this merge are shared, not competing edits: do not flag them as overlap.
      const peer = app.store.listSessions().find(other => other.branch === args.branch);
      if (peer) for (const file of result.files) app.store.markOverlapSeen(file, session.id, peer.id);
      await recordCommit(session, result.sha, result.files);
    }
    return data(result);
  }));
}

export const handleMcp: McpHandler = async (app, token, req, res) => {
  const reply = (status: number, error: string, headers: Record<string, string> = {}) => {
    res.writeHead(status, {'Content-Type': 'application/json', ...headers}).end(JSON.stringify({error}));
  };
  // Stateless: there is no session for a GET stream or a DELETE to refer to.
  if (req.method !== 'POST') return reply(405, 'method not allowed', {Allow: 'POST'});
  const session = app.store.getSessionByToken(token);
  if (!session) return reply(404, 'not found');
  app.store.updateSession(session.id, {lastActiveAt: Date.now()});

  const server = new McpServer({name: 'align', version: '0.1.0'});
  registerTools(server, app, session.id);
  const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true});
  res.on('close', () => {
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
};
