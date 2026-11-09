// Domain and wire types shared by the server and the web client.
// Ids are short prefixed strings: D1 developer, S1 session, T1 task, M1 message, I1 impact.

export type AgentKind = 'claude' | 'codex';
export type SessionStatus = 'idle' | 'starting' | 'running' | 'error';
export type TaskStatus = 'planned' | 'in_progress' | 'blocked' | 'done';
export type MemoryKind = 'decision' | 'convention' | 'rule' | 'context';

export type MessageKind = 'question' | 'answer' | 'request' | 'response' | 'notice' | 'decision_change' | 'task_change';
/** queued → delivered (written into the agent's turn) → read (agent stream confirmed it) → processed (agent responded). */
export type MessageState = 'queued' | 'delivered' | 'read' | 'processed';

export type ImpactState = 'pending' | 'delivered' | 'acknowledged' | 'adapted' | 'no_change' | 'conflict';
export type ImpactOutcome = 'adapted' | 'no_change' | 'conflict';

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  baseBranch: string;
}

export interface Developer {
  id: string;
  name: string;
  color: string;
  online: boolean;
}

export interface Session {
  id: string;
  /** Unguessable token embedded in the session's MCP URL. Never leaves the server. */
  mcpToken?: never;
  /** Stable agent-facing address, e.g. "alice-claude". */
  handle: string;
  developerId: string;
  agent: AgentKind;
  title: string;
  status: SessionStatus;
  statusDetail: string | null;
  taskId: string | null;
  branch: string;
  worktreePath: string;
  baseSha: string;
  headSha: string | null;
  nativeSessionId: string | null;
  autoTurns: number;
  createdAt: number;
  lastActiveAt: number;
}

export interface TaskDecisionLink {
  key: string;
  /** Latest version of the decision this task has acknowledged. */
  ackedVersion: number;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  note: string;
  sessionId: string;
  developerId: string;
  agent: AgentKind;
  branch: string;
  worktreePath: string;
  files: string[];
  dependsOn: string[];
  decisions: TaskDecisionLink[];
  createdAt: number;
  updatedAt: number;
}

export interface MemoryEntry {
  key: string;
  kind: MemoryKind;
  title: string;
  body: string;
  version: number;
  gbrainSlug: string;
  /** Null actor means the page changed directly in GBrain. */
  authorSessionId: string | null;
  updatedAt: number;
}

export interface MemoryVersion {
  key: string;
  version: number;
  title: string;
  body: string;
  authorSessionId: string | null;
  createdAt: number;
}

export interface AgentMessage {
  id: string;
  /** Null for messages produced by the coordination engine itself. */
  fromSessionId: string | null;
  toSessionId: string;
  kind: MessageKind;
  subject: string;
  body: string;
  replyToId: string | null;
  taskId: string | null;
  decisionKey: string | null;
  impactId: string | null;
  requiresAction: boolean;
  state: MessageState;
  createdAt: number;
  deliveredAt: number | null;
  readAt: number | null;
  processedAt: number | null;
}

export type ImpactSource = 'decision' | 'task';

export interface Impact {
  id: string;
  source: ImpactSource;
  /** Decision key, or the id of the task that changed. */
  sourceKey: string;
  fromVersion: number | null;
  toVersion: number | null;
  actorSessionId: string | null;
  taskId: string;
  sessionId: string;
  messageId: string | null;
  state: ImpactState;
  note: string;
  commitSha: string | null;
  reminders: number;
  createdAt: number;
  deliveredAt: number | null;
  acknowledgedAt: number | null;
  resolvedAt: number | null;
}

export type FileState = 'added' | 'modified' | 'deleted' | 'renamed';

export interface FileChange {
  sessionId: string;
  path: string;
  state: FileState;
  additions: number;
  deletions: number;
  committed: boolean;
}

export type IssueKind = 'file_overlap' | 'stale_decision' | 'conflict' | 'stalled' | 'wake_limit';

export interface Issue {
  id: string;
  kind: IssueKind;
  sessionIds: string[];
  taskIds: string[];
  /** File path, decision key, impact id, or message id, depending on kind. */
  subject: string;
  impactId: string | null;
}

export type ActivityType =
  | 'session_started'
  | 'task_registered'
  | 'task_updated'
  | 'task_done'
  | 'memory_published'
  | 'memory_updated'
  | 'memory_read'
  | 'decision_requested'
  | 'decision_recorded'
  | 'publish_rejected'
  | 'impact_created'
  | 'impact_resolved'
  | 'message_sent'
  | 'message_delivered'
  | 'message_processed'
  | 'overlap_detected'
  | 'commit'
  | 'gate_blocked'
  | 'wake_limit';

export interface Activity {
  id: number;
  type: ActivityType;
  actorSessionId: string | null;
  targetSessionId: string | null;
  taskId: string | null;
  /** Decision key, file path, message id, or commit sha; rendered by the UI per type. */
  subject: string;
  /** Compact structured detail, e.g. {"from":1,"to":2,"outcome":"adapted"}. */
  data: Record<string, unknown>;
  createdAt: number;
}

export interface Runtime {
  gbrain: 'starting' | 'ready' | 'unavailable';
  claude: boolean;
  codex: boolean;
}

export interface Snapshot {
  project: Project | null;
  developers: Developer[];
  sessions: Session[];
  tasks: Task[];
  memory: MemoryEntry[];
  messages: AgentMessage[];
  impacts: Impact[];
  files: FileChange[];
  issues: Issue[];
  activity: Activity[];
  runtime: Runtime;
}

export type ItemKind = 'user' | 'coordination' | 'assistant' | 'tool' | 'error';
export type ToolCategory = 'shell' | 'edit' | 'read' | 'search' | 'align' | 'other';
export type ToolStatus = 'running' | 'ok' | 'error';

export interface ToolInfo {
  name: string;
  category: ToolCategory;
  /** One-line summary: the command, the file path, the query. */
  summary: string;
  output: string;
  status: ToolStatus;
}

export interface ChatItem {
  id: string;
  sessionId: string;
  seq: number;
  kind: ItemKind;
  text: string;
  tool: ToolInfo | null;
  /** For 'user' items. */
  developerId: string | null;
  /** For 'coordination' items. */
  messageIds: string[];
  /** The session's current task when the item was written. */
  taskId: string | null;
  streaming: boolean;
  createdAt: number;
}

export type ServerEvent =
  | {type: 'snapshot'; data: Snapshot}
  | {type: 'item'; item: ChatItem}
  /** Appends to `text`, or to `tool.output` for tool items. The client upserts items by id. */
  | {type: 'delta'; sessionId: string; itemId: string; text: string};

export interface CreateSessionBody {
  developerId: string;
  agent: AgentKind;
  prompt: string;
}

export interface PromptBody {
  developerId: string;
  text: string;
}

export interface ProjectBody {
  repoPath: string;
}

export interface DeveloperBody {
  name: string;
}

export interface ApiError {
  error: string;
}
