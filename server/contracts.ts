// Module boundaries. Every server module is built against these interfaces and
// receives the shared `App` object. Factories keep `app` and must not read any
// other field of it until one of their methods is called, because index.ts
// fills `App` field by field.
import type {IncomingMessage, Server, ServerResponse} from 'node:http';
import type {
  Activity,
  ActivityType,
  AgentKind,
  AgentMessage,
  ChatItem,
  Developer,
  FileChange,
  Impact,
  ImpactOutcome,
  ImpactSource,
  ImpactState,
  Issue,
  MemoryEntry,
  MemoryKind,
  MemoryVersion,
  MessageKind,
  MessageState,
  Project,
  Runtime,
  ServerEvent,
  Session,
  Snapshot,
  Task,
  TaskStatus,
  ToolCategory,
} from '../shared/types.ts';

export interface Config {
  home: string;
  dbPath: string;
  worktreesDir: string;
  gbrainHome: string;
  port: number;
  /** Absolute path of the bun executable, or null when not found. */
  bunBin: string | null;
  /** Absolute path of GBrain's src/cli.ts, or null when not found. */
  gbrainCli: string | null;
  claudeBin: string | null;
  codexBin: string | null;
  claudeModel: string | null;
  codexModel: string | null;
  codexEffort: string;
  /** Maximum coordination-triggered turns or steers between two user prompts. */
  maxAutoTurns: number;
}

/** Server-side session row. `Session` (the wire type) must never carry these extras; Bus strips them. */
export type SessionRow = Omit<Session, 'mcpToken'> & {mcpToken: string; runnerPid: number | null};
export type NewSession = Omit<SessionRow, 'id' | 'autoTurns' | 'createdAt' | 'lastActiveAt' | 'statusDetail' | 'headSha' | 'nativeSessionId' | 'taskId' | 'status' | 'runnerPid'>;
export type NewTask = Pick<Task, 'title' | 'description' | 'status' | 'sessionId'>;
export type NewMessage = Pick<AgentMessage, 'fromSessionId' | 'toSessionId' | 'kind' | 'subject' | 'body' | 'requiresAction'> & Partial<Pick<AgentMessage, 'replyToId' | 'taskId' | 'decisionKey' | 'impactId'>>;
export type NewImpact = Pick<Impact, 'source' | 'sourceKey' | 'fromVersion' | 'toVersion' | 'actorSessionId' | 'taskId' | 'sessionId'>;
export type NewItem = Pick<ChatItem, 'sessionId' | 'kind' | 'text'> & Partial<Pick<ChatItem, 'tool' | 'developerId' | 'messageIds' | 'streaming' | 'id' | 'taskId'>>;
export type NewActivity = {type: ActivityType; actorSessionId?: string | null; targetSessionId?: string | null; taskId?: string | null; subject?: string; data?: Record<string, unknown>};
export type StoredMemory = MemoryEntry & {gbrainRevision: string; gbrainUpdatedAt: string};

/**
 * Patches are partial: implementations skip undefined keys. node:sqlite cannot
 * bind booleans or undefined, so booleans are stored as 0/1 and arrays/objects as JSON.
 * List methods with an optional limit return every row when it is omitted, newest first.
 */
export interface Store {
  getProject(): Project | null;
  setProject(p: Omit<Project, 'id'>): Project;

  upsertDeveloper(name: string): Developer;
  getDeveloper(id: string): Developer | null;
  listDevelopers(): Omit<Developer, 'online'>[];

  /** Reserves a unique [a-z0-9-]+ handle, with a fallback for names without ASCII letters. Reservations survive until createSession. */
  allocateHandle(developerId: string, agent: AgentKind): string;
  createSession(input: NewSession): SessionRow;
  getSession(id: string): SessionRow | null;
  getSessionByToken(token: string): SessionRow | null;
  /** Accepts a session id or a handle. */
  resolveSession(ref: string): SessionRow | null;
  listSessions(): SessionRow[];
  updateSession(id: string, patch: Partial<SessionRow>): SessionRow;

  addItem(input: NewItem): ChatItem;
  updateItem(id: string, patch: Partial<Pick<ChatItem, 'text' | 'tool' | 'streaming'>>): ChatItem;
  getItem(id: string): ChatItem | null;
  /** Oldest first. */
  listItems(sessionId: string): ChatItem[];
  /** Boot repair: ends streaming items and marks running tools as errors. */
  closeOpenItems(): void;

  createTask(input: NewTask): Task;
  getTask(id: string): Task | null;
  listTasks(): Task[];
  updateTask(id: string, patch: Partial<Pick<Task, 'title' | 'description' | 'status' | 'note' | 'files'>>): Task;
  addTaskDependency(taskId: string, dependsOnTaskId: string): void;
  /** Tasks whose dependsOn includes taskId. */
  listDependents(taskId: string): Task[];
  /** Links the task to a decision and raises ackedVersion to at least the given version. 0 means declared before it exists. */
  linkTaskDecision(taskId: string, key: string, ackedVersion: number): void;
  /** Tasks linked to the decision. */
  listTasksUsingDecision(key: string): Task[];

  getMemory(key: string): StoredMemory | null;
  listMemory(): MemoryEntry[];
  upsertMemory(entry: StoredMemory): void;
  setMemorySync(key: string, gbrainRevision: string, gbrainUpdatedAt: string): void;
  addMemoryVersion(v: MemoryVersion): void;
  getMemoryVersion(key: string, version: number): MemoryVersion | null;

  createMessage(input: NewMessage): AgentMessage;
  getMessage(id: string): AgentMessage | null;
  updateMessage(id: string, patch: Partial<Pick<AgentMessage, 'state' | 'deliveredAt' | 'readAt' | 'processedAt'>>): AgentMessage;
  listMessages(limit?: number): AgentMessage[];
  /** Oldest first. */
  listMessagesForSession(sessionId: string, states?: MessageState[]): AgentMessage[];

  createImpact(input: NewImpact): Impact;
  getImpact(id: string): Impact | null;
  updateImpact(id: string, patch: Partial<Pick<Impact, 'toVersion' | 'state' | 'note' | 'commitSha' | 'reminders' | 'messageId' | 'createdAt' | 'deliveredAt' | 'acknowledgedAt' | 'resolvedAt'>>): Impact;
  listImpacts(limit?: number): Impact[];
  /** Impacts for the session whose state is pending, delivered or acknowledged, or one of `states` if given. */
  listOpenImpacts(sessionId: string, states?: ImpactState[]): Impact[];
  /** Open impact for this task and source, if any. */
  findOpenImpact(taskId: string, source: ImpactSource, sourceKey: string): Impact | null;

  replaceFiles(sessionId: string, files: FileChange[]): void;
  listFiles(): FileChange[];

  /** Returns true the first time this pair of sessions overlaps on this file. */
  markOverlapSeen(path: string, a: string, b: string): boolean;

  addActivity(input: NewActivity): Activity;
  listActivity(limit?: number): Activity[];
  /** Most recent `commit` activity by this session strictly after the time, or null. */
  latestCommitSince(sessionId: string, afterMs: number): Activity | null;
}

export interface Bus {
  /** Schedule a throttled snapshot broadcast. Call after any state change. */
  touch(): void;
  emit(event: Exclude<ServerEvent, {type: 'snapshot'}>): void;
  /** Builds the current snapshot, strips SessionRow extras, adds presence, limits activity to 200 rows. */
  snapshot(): Snapshot;
  /** Registers presence for a websocket connection; returns the removal callback. */
  connect(developerId: string | null, send: (event: ServerEvent) => void): () => void;
  /** GBrain's module owns `gbrain`; index.ts sets `claude` and `codex`. */
  setRuntime(patch: Partial<Runtime>): void;
}

export interface CommitResult {
  sha: string;
  files: string[];
}

export type MergeResult =
  | {status: 'merged'; sha: string; files: string[]}
  | {status: 'up_to_date'}
  | {status: 'conflict'; paths: string[]};

/** Operations on one worktree are serialized. Read-only scans use `git --no-optional-locks`. */
export interface Git {
  /** Throws when the path is not a git repo with at least one commit. */
  inspectRepo(repoPath: string): Promise<{root: string; name: string; baseBranch: string}>;
  /** Creates a worktree on a new branch from the base branch; returns the base sha. */
  createWorktree(repoPath: string, baseBranch: string, branch: string, worktreePath: string): Promise<string>;
  /** Committed changes since baseSha merged with uncommitted changes. */
  listChanges(worktreePath: string, baseSha: string, sessionId: string): Promise<FileChange[]>;
  /** Stages everything and commits; null when there is nothing to commit. */
  commit(worktreePath: string, message: string, authorName: string): Promise<CommitResult | null>;
  /** Merges without editing; on conflict aborts and reports the paths. Never resolves conflicts. */
  merge(worktreePath: string, branch: string, authorName: string): Promise<MergeResult>;
  headSha(worktreePath: string): Promise<string>;
}

export interface GBrainPage {
  slug: string;
  title: string;
  body: string;
  revision: string;
}

export interface GBrainHit {
  slug: string;
  title: string;
  snippet: string;
  score: number;
}

export type PutPageResult = {status: 'ok'; revision: string} | {status: 'conflict'};

export interface GBrain {
  /** Retries with backoff in the background. `unavailable` only when bun or the CLI is missing. */
  start(): Promise<void>;
  stop(): Promise<void>;
  ready(): boolean;
  /** Creates a page when expectedRevision is omitted; otherwise updates only if it still matches. */
  putPage(slug: string, markdown: string, expectedRevision?: string): Promise<PutPageResult>;
  /** Plain body and title, with GBrain's quoting wrappers removed; null when missing. */
  getPage(slug: string): Promise<GBrainPage | null>;
  search(query: string, slugPrefix: string, limit: number): Promise<GBrainHit[]>;
  listPages(slugPrefix: string): Promise<{slug: string; title: string; updatedAt: string}[]>;
}

export interface PublishInput {
  key: string;
  kind: MemoryKind;
  title: string;
  body: string;
  expectedVersion?: number;
}

export type PublishResult =
  | {status: 'created' | 'updated' | 'unchanged'; entry: MemoryEntry}
  | {status: 'version_conflict'; entry: MemoryEntry};

export interface MemoryRead {
  entry: MemoryEntry;
  previous: MemoryVersion | null;
}

/** publish, get and each external-watch tick run through one promise-chain lock. */
export interface MemoryService {
  publish(actor: SessionRow | null, input: PublishInput): Promise<PublishResult>;
  /** Reads through GBrain. When the actor has a task, links it at the version read and acknowledges matching impacts. */
  get(actor: SessionRow | null, key: string): Promise<MemoryRead | null>;
  search(query: string): Promise<{key: string | null; title: string; snippet: string; slug: string}[]>;
  /** Start polling GBrain for pages edited outside Align. */
  startExternalWatch(): void;
  stop(): void;
}

export interface SendMessageInput {
  to: string;
  kind: MessageKind;
  subject: string;
  body: string;
  replyToId?: string;
  taskId?: string;
  requiresAction?: boolean;
}

export type GateResult = {ok: true} | {ok: false; openImpacts: Impact[]; uncommitted: string[]};
export type TurnStatus = 'completed' | 'failed' | 'interrupted';

export interface Coordination {
  /** Called by MemoryService after a version is stored. `previous` null means v1. Creates impacts and delivers them. */
  onMemoryChanged(entry: MemoryEntry, previous: MemoryVersion | null, actorSessionId: string | null): void;
  /** Called after an agent or the UI changes a task, with its prior state. */
  onTaskChanged(task: Task, previous: Task, interfaceChange: string | null): void;
  onFilesChanged(sessionId: string): void;
  /** Wakes or reminds only when status is `completed`. Makes at most one delivery per call. */
  onTurnEnded(sessionId: string, status: TurnStatus): void;
  /** Throws an Error with an agent-readable message on invalid input, including self-sends. */
  sendMessage(from: SessionRow | null, input: SendMessageInput): AgentMessage;
  /** Records an agent's acknowledgment and outcome. Throws an Error with an agent-readable message on invalid input. */
  ackImpact(actor: SessionRow, impactId: string, outcome: ImpactOutcome | 'acknowledged', note: string): Impact;
  /** Blocks completing a task with unresolved impacts or uncommitted files. */
  completionGate(taskId: string): Promise<GateResult>;
  /** Runner confirmed the agent consumed these messages. Moves delivered → read; notices go straight to processed. */
  markRead(messageIds: string[]): void;
  /** Returns delivered-but-unconsumed messages to queued and their impacts to pending. */
  requeue(messageIds: string[]): void;
  /** Used when a user prompt opens a turn: renders queued messages, marks them and their impacts delivered. Null when none. */
  claimQueued(sessionId: string): {text: string; messageIds: string[]} | null;
  /** Delivers queued messages if the session can take them now. Marks delivered on steered/started. Null when none are queued. */
  flush(sessionId: string): DeliveryResult | null;
  deriveIssues(): Issue[];
}

export type DeliveryResult = 'steered' | 'started' | 'queued' | 'over_budget';

/**
 * Owner checks live in http.ts; SessionManager does not authorize.
 *
 * SessionManager writes all ChatItems, including `coordination` items on both
 * `deliver` and `prompt`, and keeps the clientId → {messageIds, userText} map
 * that drives markRead and requeue.
 *
 * Streaming: on the first `text_delta` or `tool_start` it calls
 * addItem({id: itemId, streaming: true, ...}) and emits `item` before any delta.
 * `delta` appends to `text`, or to `tool.output` for tool items. `text_done`
 * and `tool_end` update the item with streaming false and re-emit it.
 */
export interface SessionManager {
  create(input: {developerId: string; agent: AgentKind; prompt: string}): Promise<Session>;
  /** User prompt: steers a live turn, or opens a turn (with claimQueued). Accepted from `error`. Resets autoTurns. A prompt to a session whose task is done first creates a new task from its first line. */
  prompt(sessionId: string, developerId: string, text: string): Promise<void>;
  /**
   * Coordination text. Live turn: steer. Idle with wake and a persisted native
   * session: start an automatic turn. Otherwise `queued`. When `wake` is true it
   * enforces the budget, increments autoTurns on steered/started, records
   * `wake_limit`, and returns `over_budget` at the limit. Sessions in `error` return `queued`.
   */
  deliver(sessionId: string, text: string, messageIds: string[], wake: boolean): DeliveryResult;
  interrupt(sessionId: string): void;
  shutdown(): Promise<void>;
}

export interface App {
  config: Config;
  store: Store;
  bus: Bus;
  git: Git;
  gbrain: GBrain;
  memory: MemoryService;
  coordination: Coordination;
  sessions: SessionManager;
}

// ---- Agent runners -------------------------------------------------------

export type RunnerEvent =
  /** Stashed by SessionManager; persisted only after the first input_consumed. */
  | {type: 'native_session'; id: string}
  | {type: 'pid'; pid: number | null}
  | {type: 'turn_started'}
  | {type: 'text_delta'; itemId: string; text: string}
  | {type: 'text_done'; itemId: string; text: string}
  | {type: 'tool_start'; itemId: string; name: string; category: ToolCategory; summary: string}
  | {type: 'tool_output'; itemId: string; text: string}
  | {type: 'tool_end'; itemId: string; ok: boolean; output: string}
  /** The agent's stream confirmed it consumed a steered or turn-opening input. */
  | {type: 'input_consumed'; clientId: string}
  /** The agent refused a steer that `steer()` had already accepted. */
  | {type: 'input_rejected'; clientId: string}
  /** Exactly one per turn. Always emitted before `exit` if a turn was active, including on spawn errors. */
  | {type: 'turn_end'; status: TurnStatus; error: string | null}
  /** The underlying process ended. */
  | {type: 'exit'; error: string | null};

export interface RunnerOptions {
  worktreePath: string;
  mcpUrl: string;
  systemPrompt: string;
  /** Read on every spawn or resume. Null until the agent has consumed its first input. */
  getNativeSessionId: () => string | null;
  config: Config;
  onEvent: (event: RunnerEvent) => void;
}

export interface AgentRunner {
  readonly kind: AgentKind;
  /** Begins a turn. Valid whenever no turn is starting or active, even while the prior process is still closing (the runner waits for it). */
  startTurn(text: string, clientId: string): void;
  /** Injects input into a starting or active turn, buffering if needed. False only when there is no such turn. */
  steer(text: string, clientId: string): boolean;
  /** If requested before the turn has really started, it is applied once it does. */
  interrupt(): void;
  dispose(): Promise<void>;
}

export type RunnerFactory = (options: RunnerOptions) => AgentRunner;

// ---- Module factories (exact names; index.ts imports these) ---------------
//
// server/config.ts         export function loadConfig(): Config
// server/store.ts          export function createStore(config: Config): Store
// server/bus.ts            export function createBus(app: App): Bus
// server/git.ts            export function createGit(): Git
// server/gbrain.ts         export function createGBrain(app: App): GBrain
// server/memory.ts         export function createMemory(app: App): MemoryService
// server/coordination.ts   export function createCoordination(app: App): Coordination
// server/sessions.ts       export function createSessions(app: App): SessionManager
// server/agents/claude.ts  export const createClaudeRunner: RunnerFactory
// server/agents/codex.ts   export const createCodexRunner: RunnerFactory
// server/http.ts           export function createHttpServer(app: App): Server
// server/mcp.ts            export const handleMcp: McpHandler
// server/prompts.ts        export const systemPrompt: SystemPromptFn
//                          export const renderCoordination: RenderCoordinationFn
//                          export const renderReminder: RenderReminderFn

export type McpHandler = (app: App, token: string, req: IncomingMessage, res: ServerResponse) => Promise<void>;
export type SystemPromptFn = (session: SessionRow, developerName: string, task: Task | null) => string;
/** Includes each message's id and the exact reply form for questions and requests. */
export type RenderCoordinationFn = (app: App, messages: AgentMessage[]) => string;
export type RenderReminderFn = (app: App, impacts: Impact[]) => string;
export type HttpServerFactory = (app: App) => Server;

export type {MessageKind, ImpactSource, TaskStatus};
