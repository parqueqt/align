import {useState} from 'react';
import type {Impact, Session} from '../../shared/types.ts';
import {Graph} from './Graph.tsx';
import {Panel} from './Panel.tsx';
import {isOpen, useAlign} from './state.ts';
import {AgentMark, StatusDot} from './ui.tsx';

export function Overview() {
  const {snapshot} = useAlign();
  return (
    <div className="overview">
      <Graph />
      {snapshot.impacts.length > 0 && <Flows />}
      <Agents />
      <Panel />
    </div>
  );
}

const STEPS = ['Notified', 'Delivered', 'Acknowledged', 'Outcome'];
const STEP_OF: Record<Impact['state'], number> = {pending: 0, delivered: 1, acknowledged: 2, adapted: 3, no_change: 3, conflict: 3};
const OUTCOME_WORD: Partial<Record<Impact['state'], string>> = {adapted: 'adapted', no_change: 'unchanged', conflict: 'conflict'};

function Stepper({impact}: {impact: Impact}) {
  const reached = STEP_OF[impact.state];
  const word = OUTCOME_WORD[impact.state];
  return (
    <span className="stepper">
      {STEPS.map((step, i) => {
        const state = i > reached ? '' : i < reached ? 'done' : isOpen(impact.state) ? 'now' : `end-${impact.state}`;
        return <i key={step} className={state} title={step} aria-label={step} />;
      })}
      {word && <span className={`stepper-word end-${impact.state}`}>{word}</span>}
    </span>
  );
}

function versionLabel(impact: Impact): string | null {
  if (impact.toVersion === null) return null;
  return impact.fromVersion ? `v${impact.fromVersion}→v${impact.toVersion}` : `v${impact.toVersion}`;
}

function Flows() {
  const {snapshot, lookup} = useAlign();
  const impacts = [...snapshot.impacts].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <section className="flows">
      <h2>Flows</h2>
      <div className="flows-list">
        {impacts.map((impact) => {
          const name = impact.source === 'decision' ? impact.sourceKey : (lookup.tasks.get(impact.sourceKey)?.title ?? impact.sourceKey);
          const versions = versionLabel(impact);
          return (
            <a key={impact.id} className="flow" href={`#/s/${impact.sessionId}`}>
              <span className="flow-head">
                <span className="flow-name trunc">{name}</span>
                {versions && <span className="flow-version">{versions}</span>}
                {impact.commitSha && <code className="flow-sha">{impact.commitSha.slice(0, 7)}</code>}
              </span>
              <span className="flow-foot">
                <span className="trunc muted">
                  {lookup.handle(impact.actorSessionId) ?? 'gbrain'} → {lookup.handle(impact.sessionId)}
                </span>
                <Stepper impact={impact} />
              </span>
            </a>
          );
        })}
      </div>
    </section>
  );
}

const FILES_SHOWN = 6;

function AgentRow({session}: {session: Session}) {
  const {snapshot, lookup} = useAlign();
  const [all, setAll] = useState(false);
  const files = snapshot.files.filter((f) => f.sessionId === session.id);
  const shown = all ? files : files.slice(0, FILES_SHOWN);
  const task = lookup.tasks.get(session.taskId)?.title ?? session.title;

  return (
    <div className="agent">
      <span className="agent-who">
        <AgentMark agent={session.agent} />
        <span className="trunc">{lookup.developers.get(session.developerId)?.name}</span>
      </span>
      <a className="agent-task trunc" href={`#/s/${session.id}`} title={task}>
        {task}
      </a>
      <span className="agent-dot">
        <StatusDot status={session.status} />
      </span>
      <code className="agent-branch trunc" title={session.worktreePath}>
        {session.branch}
      </code>
      {files.length > 0 && (
        <div className="agent-files">
          {shown.map((f) => (
            <span key={f.path} className="file" title={f.path}>
              <code className="file-path">{f.path}</code>
              {f.additions > 0 && <span className="add">+{f.additions}</span>}
              {f.deletions > 0 && <span className="del">−{f.deletions}</span>}
            </span>
          ))}
          {files.length > FILES_SHOWN && !all && (
            <button className="more" onClick={() => setAll(true)}>
              +{files.length - FILES_SHOWN}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Agents() {
  const {snapshot} = useAlign();
  if (snapshot.sessions.length === 0) return null;
  const sessions = [...snapshot.sessions].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <section className="span-all">
      <h2>Agents</h2>
      {sessions.map((s) => (
        <AgentRow key={s.id} session={s} />
      ))}
    </section>
  );
}
