import type {AgentMessage, Impact, ImpactState, Issue, Task} from '../shared/types.ts';
import type {App, Coordination, DeliveryResult, GateResult, NewImpact, NewMessage, SessionRow} from './contracts.ts';
import {renderCoordination, renderReminder} from './prompts.ts';

const MAX_REMINDERS = 2;
const OPEN_STATES: ImpactState[] = ['pending', 'delivered', 'acknowledged'];

const isOpen = (impact: Impact) => OPEN_STATES.includes(impact.state);
const reachedAgent = (result: DeliveryResult) => result === 'steered' || result === 'started';

type EngineMessage = Omit<NewMessage, 'impactId'>;

/** path → session id → task ids working on it. */
type FileClaims = Map<string, Map<string, Set<string>>>;

export function createCoordination(app: App): Coordination {
  const impactOf = (message: AgentMessage): Impact | null => (message.impactId ? app.store.getImpact(message.impactId) : null);

  function markProcessed(messageId: string): void {
    const message = app.store.getMessage(messageId);
    if (message && message.state !== 'processed') app.store.updateMessage(messageId, {state: 'processed', processedAt: Date.now()});
  }

  function markDelivered(messages: AgentMessage[]): void {
    const now = Date.now();
    for (const message of messages) {
      app.store.updateMessage(message.id, {state: 'delivered', deliveredAt: now});
      const impact = impactOf(message);
      // An impact already acknowledged through memory_get must not fall back to delivered.
      if (impact?.state === 'pending') app.store.updateImpact(impact.id, {state: 'delivered', deliveredAt: now});
      app.store.addActivity({
        type: 'message_delivered',
        actorSessionId: message.fromSessionId,
        targetSessionId: message.toSessionId,
        taskId: message.taskId,
        subject: message.id,
        data: {kind: message.kind},
      });
    }
  }

  function flush(sessionId: string): DeliveryResult | null {
    const queued = app.store.listMessagesForSession(sessionId, ['queued']);
    if (queued.length === 0) return null;
    const result = app.sessions.deliver(
      sessionId,
      renderCoordination(app, queued),
      queued.map(message => message.id),
      queued.some(message => message.requiresAction),
    );
    if (reachedAgent(result)) markDelivered(queued);
    app.bus.touch();
    return result;
  }

  function raiseImpact(spec: NewImpact, message: EngineMessage): void {
    const open = app.store.findOpenImpact(spec.taskId, spec.source, spec.sourceKey);
    const impact = open ?? app.store.createImpact(spec);
    const created = app.store.createMessage({...message, impactId: impact.id});
    if (open) {
      if (open.messageId) markProcessed(open.messageId);
      app.store.updateImpact(open.id, {
        toVersion: spec.toVersion,
        createdAt: Date.now(),
        state: 'pending',
        reminders: 0,
        deliveredAt: null,
        acknowledgedAt: null,
        messageId: created.id,
      });
    } else {
      app.store.updateImpact(impact.id, {messageId: created.id});
    }
    app.store.addActivity({
      type: 'impact_created',
      actorSessionId: spec.actorSessionId,
      targetSessionId: spec.sessionId,
      taskId: spec.taskId,
      subject: spec.sourceKey,
      data: {impactId: impact.id, source: spec.source, from: impact.fromVersion, to: spec.toVersion, superseded: open !== null},
    });
  }

  /** Non-done tasks only: each session's changed files count for its current task, declared files for their own task. */
  function fileClaims(): FileClaims {
    const claims: FileClaims = new Map();
    const claim = (path: string, sessionId: string, taskId: string) => {
      const owners = claims.get(path) ?? new Map<string, Set<string>>();
      claims.set(path, owners);
      const tasks = owners.get(sessionId) ?? new Set<string>();
      owners.set(sessionId, tasks);
      tasks.add(taskId);
    };

    const active = new Map<string, Task>();
    for (const task of app.store.listTasks()) {
      if (task.status === 'done') continue;
      active.set(task.id, task);
      for (const path of task.files) claim(path, task.sessionId, task.id);
    }
    const currentTask = new Map(app.store.listSessions().map(session => [session.id, session.taskId]));
    for (const file of app.store.listFiles()) {
      const taskId = currentTask.get(file.sessionId);
      if (taskId && active.has(taskId)) claim(file.path, file.sessionId, taskId);
    }
    return claims;
  }

  function resolveRecipient(to: string): SessionRow {
    const session = app.store.resolveSession(to);
    if (session) return session;
    const task = app.store.getTask(to);
    const owner = task ? app.store.getSession(task.sessionId) : null;
    if (!owner) throw new Error(`Unknown recipient "${to}": use a session handle, session id, or task id`);
    return owner;
  }

  function sendOutcomeNotice(actor: SessionRow, impact: Impact, author: string | null, outcome: Impact['state'], note: string, commitSha: string | null): void {
    if (!author || author === actor.id) return;
    const change = impact.source === 'decision' ? `"${impact.sourceKey}" v${impact.fromVersion ?? 0} to v${impact.toVersion ?? 0}` : `task ${impact.sourceKey}`;
    const details = [commitSha ? `commit ${commitSha}` : null, note || null].filter(Boolean).join('; ');
    app.store.createMessage({
      fromSessionId: actor.id,
      toSessionId: author,
      kind: 'notice',
      subject: `Impact ${impact.id} ${outcome}`,
      body: `${actor.handle} resolved ${change} as ${outcome} on task ${impact.taskId}${details ? ` (${details})` : ''}.`,
      requiresAction: false,
      taskId: impact.taskId,
    });
    flush(author);
  }

  return {
    onMemoryChanged(entry, _previous, actorSessionId) {
      const affected = new Set<string>();
      for (const task of app.store.listTasksUsingDecision(entry.key)) {
        if (task.sessionId === actorSessionId) continue;
        const acked = task.decisions.find(link => link.key === entry.key)?.ackedVersion ?? 0;
        if (acked >= entry.version) continue;
        raiseImpact(
          {source: 'decision', sourceKey: entry.key, fromVersion: acked, toVersion: entry.version, actorSessionId, taskId: task.id, sessionId: task.sessionId},
          {
            fromSessionId: actorSessionId,
            toSessionId: task.sessionId,
            kind: 'decision_change',
            subject: `${entry.key} v${acked} to v${entry.version}`,
            body: entry.body,
            requiresAction: true,
            taskId: task.id,
            decisionKey: entry.key,
          },
        );
        affected.add(task.sessionId);
      }
      for (const sessionId of affected) flush(sessionId);
      app.bus.touch();
    },

    onTaskChanged(task, previous, interfaceChange) {
      const dependents = app.store.listDependents(task.id).filter(dependent => dependent.sessionId !== task.sessionId);
      const affected = new Set<string>();

      if (interfaceChange) {
        for (const dependent of dependents) {
          raiseImpact(
            {source: 'task', sourceKey: task.id, fromVersion: null, toVersion: null, actorSessionId: task.sessionId, taskId: dependent.id, sessionId: dependent.sessionId},
            {
              fromSessionId: task.sessionId,
              toSessionId: dependent.sessionId,
              kind: 'task_change',
              subject: `${task.id} ${task.title}`,
              body: interfaceChange,
              requiresAction: true,
              taskId: dependent.id,
            },
          );
          affected.add(dependent.sessionId);
        }
      }

      if (task.status === 'done' && previous.status !== 'done') {
        app.store.addActivity({type: 'task_done', actorSessionId: task.sessionId, taskId: task.id, subject: task.title});
        for (const dependent of dependents) {
          app.store.createMessage({
            fromSessionId: task.sessionId,
            toSessionId: dependent.sessionId,
            kind: 'notice',
            subject: `${task.id} done`,
            body: `Task ${task.id} "${task.title}" is done on branch ${task.branch}.`,
            requiresAction: true,
            taskId: dependent.id,
          });
          affected.add(dependent.sessionId);
        }
      }

      for (const sessionId of affected) flush(sessionId);
      app.bus.touch();
    },

    onFilesChanged(sessionId) {
      const fresh = new Map<string, string[]>();
      for (const [path, owners] of fileClaims()) {
        if (!owners.has(sessionId)) continue;
        for (const other of owners.keys()) {
          if (other === sessionId || !app.store.markOverlapSeen(path, sessionId, other)) continue;
          fresh.set(other, [...(fresh.get(other) ?? []), path]);
          app.store.addActivity({type: 'overlap_detected', actorSessionId: sessionId, targetSessionId: other, subject: path});
        }
      }

      const handle = (id: string) => app.store.getSession(id)?.handle ?? id;
      for (const [other, paths] of fresh) {
        for (const [to, peer] of [[sessionId, other], [other, sessionId]] as const) {
          app.store.createMessage({
            fromSessionId: null,
            toSessionId: to,
            kind: 'notice',
            subject: `File overlap with ${handle(peer)}`,
            body: `You and ${handle(peer)} are both working on: ${paths.join(', ')}`,
            requiresAction: false,
          });
          flush(to);
        }
      }
      if (fresh.size > 0) app.bus.touch();
    },

    onTurnEnded(sessionId, status) {
      if (status !== 'completed') return;
      const queued = app.store.listMessagesForSession(sessionId, ['queued']);
      const reminders = app.store
        .listOpenImpacts(sessionId, ['delivered', 'acknowledged'])
        .filter(impact => impact.reminders < MAX_REMINDERS && impact.messageId !== null && app.store.getMessage(impact.messageId)?.state === 'read');
      if (queued.length === 0 && reminders.length === 0) return;

      const text = [queued.length > 0 ? renderCoordination(app, queued) : null, reminders.length > 0 ? renderReminder(app, reminders) : null]
        .filter(Boolean)
        .join('\n\n');
      const wake = reminders.length > 0 || queued.some(message => message.requiresAction);
      const result = app.sessions.deliver(sessionId, text, queued.map(message => message.id), wake);

      if (reachedAgent(result)) markDelivered(queued);
      if (result === 'started') {
        for (const impact of reminders) app.store.updateImpact(impact.id, {reminders: impact.reminders + 1});
      }
      app.bus.touch();
    },

    sendMessage(from, input) {
      const target = resolveRecipient(input.to);
      if (from && target.id === from.id) throw new Error('Agents cannot message themselves');

      const isReply = input.kind === 'answer' || input.kind === 'response';
      let original: AgentMessage | null = null;
      if (isReply) {
        if (!input.replyToId) throw new Error(`${input.kind} requires reply_to with the id of the message you are answering`);
        original = app.store.getMessage(input.replyToId);
        if (!original) throw new Error(`Unknown message ${input.replyToId}`);
        if (!from || original.toSessionId !== from.id) throw new Error(`Message ${original.id} was not addressed to this session`);
        if (!original.fromSessionId) throw new Error(`Message ${original.id} came from Align itself and cannot be answered; use impact_ack`);
        if (original.fromSessionId !== target.id) {
          throw new Error(`Message ${original.id} came from ${app.store.getSession(original.fromSessionId)?.handle ?? original.fromSessionId}; send the ${input.kind} there`);
        }
      }

      if (input.taskId && !app.store.getTask(input.taskId)) throw new Error(`Unknown task ${input.taskId}`);
      // A reply always wakes the asker, who ended its turn to wait for it.
      const requiresAction = isReply || (input.requiresAction ?? (input.kind === 'question' || input.kind === 'request'));
      const message = app.store.createMessage({
        fromSessionId: from?.id ?? null,
        toSessionId: target.id,
        kind: input.kind,
        subject: input.subject,
        body: input.body,
        requiresAction,
        replyToId: input.replyToId ?? null,
        taskId: input.taskId ?? from?.taskId ?? null,
      });
      app.store.addActivity({
        type: 'message_sent',
        actorSessionId: from?.id ?? null,
        targetSessionId: target.id,
        taskId: message.taskId,
        subject: message.id,
        data: {kind: message.kind, title: message.subject},
      });

      if (original) {
        markProcessed(original.id);
        app.store.addActivity({type: 'message_processed', actorSessionId: from?.id ?? null, targetSessionId: original.fromSessionId, taskId: original.taskId, subject: original.id, data: {replyId: message.id}});
      }

      flush(target.id);
      return app.store.getMessage(message.id)!;
    },

    ackImpact(actor, impactId, outcome, note) {
      const impact = app.store.getImpact(impactId);
      if (!impact) throw new Error(`Unknown impact ${impactId}`);
      if (impact.sessionId !== actor.id) throw new Error(`Impact ${impactId} belongs to another session`);
      if (!isOpen(impact)) throw new Error(`Impact ${impactId} is already resolved as ${impact.state}`);

      if (outcome === 'acknowledged') {
        if (impact.source === 'decision' && impact.toVersion !== null) app.store.linkTaskDecision(impact.taskId, impact.sourceKey, impact.toVersion);
        const updated = impact.state === 'acknowledged' ? impact : app.store.updateImpact(impactId, {state: 'acknowledged', acknowledgedAt: Date.now()});
        app.bus.touch();
        return updated;
      }

      if (impact.source === 'decision' && impact.state !== 'acknowledged') {
        throw new Error(`Impact ${impactId} is not acknowledged yet: call memory_get with key "${impact.sourceKey}" first`);
      }

      const trimmed = note.trim();
      let commitSha: string | null = null;
      if (outcome === 'adapted') {
        // An impact acknowledged before delivery has no deliveredAt; the agent knew of the change from its acknowledgment.
        const since = impact.deliveredAt ?? impact.acknowledgedAt ?? impact.createdAt;
        const commit = app.store.latestCommitSince(actor.id, since);
        if (!commit) throw new Error(`Impact ${impactId} has no commit from this session since the change reached it: commit your adaptation with the commit tool first`);
        commitSha = commit.subject;
      } else if (!trimmed) {
        throw new Error(`Outcome ${outcome} requires a non-empty note`);
      }

      const message = impact.messageId ? app.store.getMessage(impact.messageId) : null;
      const author = message?.fromSessionId ?? impact.actorSessionId;
      const resolved = app.store.updateImpact(impactId, {state: outcome, note: trimmed, commitSha, resolvedAt: Date.now()});
      if (impact.messageId) markProcessed(impact.messageId);
      app.store.addActivity({
        type: 'impact_resolved',
        actorSessionId: actor.id,
        targetSessionId: author,
        taskId: impact.taskId,
        subject: impact.sourceKey,
        data: {impactId, source: impact.source, outcome, from: impact.fromVersion, to: impact.toVersion, commitSha, note: trimmed},
      });
      sendOutcomeNotice(actor, resolved, author, outcome, trimmed, commitSha);
      app.bus.touch();
      return resolved;
    },

    async completionGate(taskId): Promise<GateResult> {
      const task = app.store.getTask(taskId);
      if (!task) throw new Error(`Unknown task ${taskId}`);
      const session = app.store.getSession(task.sessionId);
      if (!session) throw new Error(`Unknown session ${task.sessionId}`);

      const changes = await app.git.listChanges(session.worktreePath, session.baseSha, session.id);
      const uncommitted = changes.filter(file => !file.committed).map(file => file.path);
      // Read after the await, so an impact raised during the scan still blocks.
      const openImpacts = app.store.listOpenImpacts(session.id).filter(impact => impact.taskId === taskId);
      if (openImpacts.length === 0 && uncommitted.length === 0) return {ok: true};

      app.store.addActivity({
        type: 'gate_blocked',
        actorSessionId: session.id,
        taskId,
        subject: taskId,
        data: {impacts: openImpacts.map(impact => impact.id), uncommitted},
      });
      app.bus.touch();
      return {ok: false, openImpacts, uncommitted};
    },

    markRead(messageIds) {
      const now = Date.now();
      for (const id of messageIds) {
        const message = app.store.getMessage(id);
        if (message?.state !== 'delivered') continue;
        app.store.updateMessage(id, message.kind === 'notice' ? {state: 'processed', readAt: now, processedAt: now} : {state: 'read', readAt: now});
      }
      app.bus.touch();
    },

    requeue(messageIds) {
      for (const id of messageIds) {
        const message = app.store.getMessage(id);
        if (message?.state !== 'delivered') continue;
        app.store.updateMessage(id, {state: 'queued', deliveredAt: null});
        const impact = impactOf(message);
        if (impact?.state === 'delivered') app.store.updateImpact(impact.id, {state: 'pending', deliveredAt: null});
      }
      app.bus.touch();
    },

    claimQueued(sessionId) {
      const queued = app.store.listMessagesForSession(sessionId, ['queued']);
      if (queued.length === 0) return null;
      const text = renderCoordination(app, queued);
      markDelivered(queued);
      app.bus.touch();
      return {text, messageIds: queued.map(message => message.id)};
    },

    flush,

    deriveIssues() {
      const issues: Issue[] = [];

      for (const [path, owners] of fileClaims()) {
        if (owners.size < 2) continue;
        issues.push({
          id: `file_overlap:${path}`,
          kind: 'file_overlap',
          sessionIds: [...owners.keys()],
          taskIds: [...new Set([...owners.values()].flatMap(tasks => [...tasks]))],
          subject: path,
          impactId: null,
        });
      }

      const impacts = app.store.listImpacts();
      for (const impact of impacts) {
        const base = {sessionIds: [impact.sessionId], taskIds: [impact.taskId], impactId: impact.id};
        if (isOpen(impact)) {
          issues.push({...base, id: `stale_decision:${impact.id}`, kind: 'stale_decision', subject: impact.sourceKey});
          if (impact.reminders >= MAX_REMINDERS) issues.push({...base, id: `stalled:${impact.id}`, kind: 'stalled', subject: impact.id});
        } else if (impact.state === 'conflict') {
          const resolvedAt = impact.resolvedAt ?? impact.createdAt;
          const superseded = impacts.some(
            later => later.id !== impact.id && later.taskId === impact.taskId && later.source === impact.source && later.sourceKey === impact.sourceKey && later.createdAt > resolvedAt,
          );
          if (!superseded) issues.push({...base, id: `conflict:${impact.id}`, kind: 'conflict', subject: impact.sourceKey});
        }
      }

      const sessions = app.store.listSessions();
      const idle = new Set(sessions.filter(session => session.status === 'idle').map(session => session.id));
      for (const message of app.store.listMessages()) {
        if (message.kind !== 'question' && message.kind !== 'request') continue;
        if (!message.requiresAction || message.state === 'processed' || !idle.has(message.toSessionId)) continue;
        issues.push({
          id: `stalled:${message.id}`,
          kind: 'stalled',
          sessionIds: [message.toSessionId],
          taskIds: message.taskId ? [message.taskId] : [],
          subject: message.id,
          impactId: null,
        });
      }

      for (const session of sessions) {
        if (session.autoTurns < app.config.maxAutoTurns) continue;
        const waiting = app.store.listMessagesForSession(session.id, ['queued']).filter(message => message.requiresAction);
        if (waiting.length === 0) continue;
        issues.push({
          id: `wake_limit:${session.id}`,
          kind: 'wake_limit',
          sessionIds: [session.id],
          taskIds: session.taskId ? [session.taskId] : [],
          subject: waiting[0]!.id,
          impactId: null,
        });
      }

      return issues;
    },
  };
}
