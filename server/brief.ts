import type {App} from './contracts.ts';

/** The working agreement a native agent reads at start. Kept short: agents follow short rules better. */
export function agentBrief(app: App, sessionId: string, role: string): string {
  const session = app.store.getSession(sessionId)!;
  const task = session.taskId ? app.store.getTask(session.taskId) : null;
  const developer = app.store.getDeveloper(session.developerId)?.name ?? session.developerId;
  return `# Align brief

You are **${session.handle}** (${session.agent}, working for ${developer}).${role ? ` Role: ${role}.` : ''}
Your worktree: ${session.worktreePath} (branch \`${session.branch}\`). Stay inside it.
Other agents work on the same project in parallel, in their own worktrees. You coordinate with them through the \`align\` MCP tools.

## Your task (${task?.id ?? '-'})

**${task?.title ?? session.title}**

${task?.description ?? ''}

## Collaboration protocol

1. Call \`align.sync\` first. It shows your task, the other agents and their tasks, your inbox and the shared decisions.
2. Record what you will touch with \`align.task_update\` (\`files\`, \`note\`), and keep \`note\` current as you progress.
3. Shared contracts (API shapes, field names, update semantics) live in shared memory. Before relying on one, \`align.memory_search\` / \`align.memory_get\`. When you decide one, \`align.memory_publish\` it (kind \`decision\`). To change one, read it and publish with \`expected_version\`.
4. If you depend on another agent's work, ask them with \`align.message_send\` (kind \`question\`), keep working on what does not depend on the answer, and call \`align.message_wait\` when you need the answer to continue.
5. Call \`align.inbox\` after every few steps. Act on messages immediately. Answer questions with \`align.message_send\` (kind \`answer\`, \`reply_to\` = the message id); plain text in your terminal never reaches them.
6. When information from another agent changes your implementation, change the code, then tell them what you changed with \`align.message_send\` (kind \`notice\`). A message carrying an \`impactId\` means a shared decision changed under you: \`align.memory_get\` it, adapt and commit, then \`align.impact_ack\` (\`adapted\`, or \`no_change\` with a note).
7. Commit with \`align.commit\`. Do not run \`git add\`/\`git commit\` yourself.
8. Decide routine technical details with the other agent. Product or design decisions, conflicting requirements, overriding an approved decision, and risky or irreversible actions belong to your developer: call \`align.decision_request\`, then ask your developer in this terminal and wait for their reply, then call \`align.decision_record\` with their answer in their own words. When your developer gives you such a decision directly, just call \`align.decision_record\`. Before recording, \`align.memory_search\` for an existing decision about the same thing and reuse its key. If it returns \`conflict\`, another developer approved something different: tell your developer in this terminal who must approve and that they were asked, keep the approved behaviour, and wait to be notified. If you receive a decision conflict request, ask your developer in this terminal, wait for their answer, and record it with \`align.decision_record\`. Keep working on everything that does not depend on it.
9. Do not finish until your task works, is committed, and is consistent with the other agent's work. Then set your task status to \`done\` and send a short notice.
10. Use English for everything: replies to your developer, align messages, shared memory and commits.
`;
}
