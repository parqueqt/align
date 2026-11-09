import {memo} from 'react';
import Markdown from 'react-markdown';
import type {Components} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {AgentKind, Developer, SessionStatus} from '../../shared/types.ts';

const AGENT_NAMES: Record<AgentKind, string> = {claude: 'Claude', codex: 'Codex'};

export function AgentMark({agent, size = 12, x, y}: {agent: AgentKind; size?: number; x?: number; y?: number}) {
  return (
    <svg className={`mark mark-${agent}`} width={size} height={size} x={x} y={y} viewBox="0 0 12 12" role="img" aria-label={AGENT_NAMES[agent]}>
      <title>{AGENT_NAMES[agent]}</title>
      {agent === 'claude' ? (
        <rect x="2.5" y="2.5" width="7" height="7" rx="1.5" transform="rotate(45 6 6)" />
      ) : (
        <rect x="1.5" y="1.5" width="9" height="9" rx="2.5" />
      )}
    </svg>
  );
}

export function StatusDot({status}: {status: SessionStatus}) {
  return <span className={`dot s-${status}`} role="img" aria-label={status} title={status} />;
}

export function Avatar({dev, current}: {dev: Developer; current?: boolean}) {
  return (
    <span
      className={`avatar${dev.online ? '' : ' offline'}${current ? ' current' : ''}`}
      style={dev.online ? {background: dev.color} : undefined}
      role="img"
      aria-label={`${dev.name}, ${dev.online ? 'online' : 'offline'}`}
      title={dev.name}
    >
      {dev.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

const plugins = [remarkGfm];
const components: Components = {
  a: ({node: _node, ...props}) => <a {...props} target="_blank" rel="noreferrer" />,
};

export const Md = memo(function Md({text}: {text: string}) {
  return (
    <div className="md">
      <Markdown remarkPlugins={plugins} components={components}>
        {text}
      </Markdown>
    </div>
  );
});
