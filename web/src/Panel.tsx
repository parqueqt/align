import {useState} from 'react';
import {
  Ban,
  BellOff,
  BookPlus,
  Check,
  CheckCheck,
  ChevronRight,
  CircleCheck,
  Clock,
  GitCommitHorizontal,
  GitMerge,
  History,
  Layers,
  Link2,
  ListPlus,
  Lock,
  Play,
  RefreshCw,
  Send,
  TriangleAlert,
} from 'lucide-react';
import type {LucideIcon} from 'lucide-react';
import type {Activity, AgentMessage, Issue, IssueKind, MemoryEntry, MessageState} from '../../shared/types.ts';
import {kindLabel, useAlign} from './state.ts';
import type {Lookup} from './state.ts';
import {Md} from './ui.tsx';

const TABS = ['Activity', 'Messages', 'Memory', 'Issues'] as const;
type Tab = (typeof TABS)[number];

export function Panel() {
  const {snapshot} = useAlign();
  const [tab, setTab] = useState<Tab>('Activity');
  const {activity, messages, memory, issues} = snapshot;
  if (activity.length + messages.length + memory.length + issues.length === 0) return null;

  return (
    <section className="span-all">
      <div className="tabs" role="tablist">
        {TABS.map((name) => (
          <button key={name} className="tab" role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>
            {name}
            {name === 'Issues' && issues.length > 0 && <span className="badge">{issues.length}</span>}
          </button>
        ))}
      </div>
      <div className="list" role="tabpanel">
        {tab === 'Activity' && <ActivityList />}
        {tab === 'Messages' && <MessageList />}
        {tab === 'Memory' && <MemoryList />}
        {tab === 'Issues' && <IssueList />}
      </div>
    </section>
  );
}

type Line = {icon: LucideIcon; main: string; tail?: string; mono?: boolean; tone?: 'good' | 'warn' | 'bad'};

function describe(a: Activity, lookup: Lookup): Line | null {
  const actor = lookup.handle(a.actorSessionId);
  const target = lookup.handle(a.targetSessionId);
  const route = actor && target ? `${actor} → ${target}` : (actor ?? target ?? undefined);
  const task = lookup.tasks.get(a.taskId)?.title ?? a.subject;
  const decision = a.data.to == null ? a.subject : `${a.subject} v${String(a.data.to)}`;
  // A task-source impact's subject is the id of the task that changed.
  const impactName = a.data.source === 'task' ? (lookup.tasks.get(a.subject)?.title ?? a.subject) : decision;

  switch (a.type) {
    case 'session_started':
      return {icon: Play, main: actor ?? a.subject};
    case 'task_registered':
      return {icon: ListPlus, main: task, tail: actor ?? undefined};
    case 'task_done':
      return {icon: CircleCheck, main: task, tail: actor ?? undefined, tone: 'good'};
    case 'memory_published':
      return {icon: BookPlus, main: decision, tail: actor ?? undefined};
    case 'memory_updated':
      return {icon: RefreshCw, main: decision, tail: actor ?? undefined};
    case 'publish_rejected':
      return {icon: Ban, main: a.subject, tail: actor ?? undefined, tone: 'warn'};
    case 'impact_created':
      return {icon: Link2, main: impactName, tail: route, tone: 'warn'};
    case 'impact_resolved': {
      const outcome = typeof a.data.outcome === 'string' ? a.data.outcome.replace('_', ' ') : '';
      return {icon: CheckCheck, main: impactName, tail: [route, outcome].filter(Boolean).join(' · '), tone: a.data.outcome === 'conflict' ? 'bad' : 'good'};
    }
    case 'message_sent': {
      const message = lookup.messages.get(a.subject);
      return {icon: Send, main: route ?? a.subject, tail: message && kindLabel(message.kind)};
    }
    case 'overlap_detected':
      return {icon: Layers, main: a.subject, tail: actor && target ? `${actor} ↔ ${target}` : route, mono: true, tone: 'warn'};
    case 'commit':
      return {icon: a.data.merged ? GitMerge : GitCommitHorizontal, main: a.subject.slice(0, 7), tail: actor ?? undefined, mono: true};
    case 'gate_blocked':
      return {icon: Lock, main: task, tail: actor ?? undefined, tone: 'warn'};
    case 'wake_limit':
      return {icon: BellOff, main: target ?? actor ?? a.subject, tone: 'warn'};
    case 'task_updated':
    case 'message_delivered':
    case 'message_processed':
      return null;
  }
}

function ActivityList() {
  const {snapshot, lookup} = useAlign();
  const rows = [...snapshot.activity]
    .sort((a, b) => b.id - a.id)
    .map((a) => ({id: a.id, line: describe(a, lookup)}))
    .filter((row) => row.line !== null);
  return rows.map(({id, line}) => {
    const Icon = line!.icon;
    return (
      <div key={id} className="row">
        <Icon size={13} className={`row-icon ${line!.tone ?? ''}`} />
        <span className={`trunc${line!.mono ? ' mono' : ''}`}>{line!.main}</span>
        {line!.tail && <span className="trunc muted">{line!.tail}</span>}
      </div>
    );
  });
}

const DELIVERY: Record<MessageState, LucideIcon> = {queued: Clock, delivered: Check, read: CheckCheck, processed: CheckCheck};

function MessageRow({message}: {message: AgentMessage}) {
  const {lookup} = useAlign();
  const Marker = DELIVERY[message.state];
  return (
    <div className="row">
      <span className="trunc message-route">
        {lookup.handle(message.fromSessionId) ?? 'align'} → {lookup.handle(message.toSessionId)}
      </span>
      <span className="tag">{kindLabel(message.kind)}</span>
      <span className="trunc grow">{message.subject}</span>
      <span className={`delivery ${message.state}`} role="img" aria-label={message.state} title={message.state}>
        <Marker size={13} />
      </span>
    </div>
  );
}

function MessageList() {
  const {snapshot} = useAlign();
  const messages = [...snapshot.messages].sort((a, b) => b.createdAt - a.createdAt);
  return messages.map((m) => <MessageRow key={m.id} message={m} />);
}

function MemoryRow({entry}: {entry: MemoryEntry}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="memory">
      <button className="row row-button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={12} className={`chevron${open ? ' open' : ''}`} />
        <span className="tag">{entry.kind}</span>
        <span className="trunc grow">{entry.key}</span>
        <span className="muted">v{entry.version}</span>
      </button>
      {open && (
        <div className="memory-body">
          <Md text={entry.body} />
        </div>
      )}
    </div>
  );
}

function MemoryList() {
  const {snapshot} = useAlign();
  const entries = [...snapshot.memory].sort((a, b) => b.updatedAt - a.updatedAt);
  return entries.map((e) => <MemoryRow key={e.key} entry={e} />);
}

const ISSUES: Record<IssueKind, {icon: LucideIcon; label: string}> = {
  file_overlap: {icon: Layers, label: 'Overlap'},
  stale_decision: {icon: History, label: 'Stale'},
  conflict: {icon: TriangleAlert, label: 'Conflict'},
  stalled: {icon: Clock, label: 'Stalled'},
  wake_limit: {icon: BellOff, label: 'Limit'},
};

function issueSubject(issue: Issue, lookup: Lookup): string {
  const impact = lookup.impacts.get(issue.impactId) ?? lookup.impacts.get(issue.subject);
  if (impact) return impact.source === 'decision' ? impact.sourceKey : (lookup.tasks.get(impact.sourceKey)?.title ?? impact.sourceKey);
  return lookup.messages.get(issue.subject)?.subject ?? lookup.handle(issue.subject) ?? issue.subject;
}

function IssueList() {
  const {snapshot, lookup} = useAlign();
  return snapshot.issues.map((issue) => {
    const {icon: Icon, label} = ISSUES[issue.kind];
    const subject = issueSubject(issue, lookup);
    const handles = issue.sessionIds.map((id) => lookup.handle(id)).filter((h) => h && h !== subject);
    return (
      <div key={issue.id} className="row">
        <Icon size={13} className="row-icon warn" />
        <span className="issue-label">{label}</span>
        <span className={`trunc grow${issue.kind === 'file_overlap' ? ' mono' : ''}`}>{subject}</span>
        <span className="trunc muted">{handles.join(', ')}</span>
      </div>
    );
  });
}
