import {useEffect, useRef, useState} from 'react';
import type {FormEvent} from 'react';
import {Brain, Check, LayoutGrid, Plus, WifiOff} from 'lucide-react';
import {api, errorText} from './api.ts';
import {NewSession} from './NewSession.tsx';
import {Overview} from './Overview.tsx';
import {SessionHeader, SessionView} from './Session.tsx';
import {isOpen, useAlign, useRoute} from './state.ts';
import type {Route} from './state.ts';
import {AgentMark, Avatar, StatusDot} from './ui.tsx';

export function Shell() {
  const route = useRoute();
  const {lookup} = useAlign();
  const [creating, setCreating] = useState(false);
  const session = route.name === 'session' ? lookup.sessions.get(route.id) : undefined;

  return (
    <div className="shell">
      <Rail route={route} onNew={() => setCreating(true)} />
      <div className="main">
        <header className="top">
          <div className="top-left">{session && <SessionHeader session={session} />}</div>
          <Indicators />
          <Developers />
        </header>
        <main className="content">
          {route.name === 'overview' && <Overview />}
          {session && <SessionView key={session.id} session={session} />}
        </main>
      </div>
      <NewSession open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function Rail({route, onNew}: {route: Route; onNew: () => void}) {
  const {snapshot, lookup} = useAlign();
  const sessions = [...snapshot.sessions].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <nav className="rail">
      <div className="rail-top">
        <a className="wordmark" href="#/" aria-label="Overview">
          align
        </a>
        <button className="icon" aria-label="New" title="New" onClick={onNew}>
          <Plus size={15} />
        </button>
      </div>
      <a className={`rail-item${route.name === 'overview' ? ' active' : ''}`} href="#/" aria-label="Overview" title="Overview">
        <span className="rail-mark">
          <LayoutGrid size={14} />
        </span>
        <span className="rail-text">Overview</span>
      </a>
      <div className="rail-list">
        {sessions.map((s) => {
          const title = lookup.tasks.get(s.taskId)?.title ?? s.title;
          const open = snapshot.impacts.filter((i) => i.sessionId === s.id && isOpen(i.state)).length;
          const active = route.name === 'session' && route.id === s.id;
          return (
            <a key={s.id} className={`rail-item${active ? ' active' : ''}`} href={`#/s/${s.id}`} title={title}>
              <span className="rail-mark">
                <AgentMark agent={s.agent} />
              </span>
              <span className="rail-text">
                <span className="trunc">{title}</span>
                <span className="trunc rail-dev">{lookup.developers.get(s.developerId)?.name}</span>
              </span>
              <StatusDot status={s.status} />
              {open > 0 && <span className="badge">{open}</span>}
            </a>
          );
        })}
      </div>
    </nav>
  );
}

function Indicators() {
  const {online, snapshot} = useAlign();
  const gbrain = snapshot.runtime.gbrain;
  return (
    <>
      {!online && (
        <span className="indicator bad" role="img" aria-label="Offline" title="Offline">
          <WifiOff size={14} />
        </span>
      )}
      {gbrain !== 'ready' && (
        <span className={`indicator ${gbrain === 'starting' ? 'warn' : 'bad'}`} role="img" aria-label={`GBrain ${gbrain}`} title={`GBrain ${gbrain}`}>
          <Brain size={14} />
        </span>
      )}
    </>
  );
}

const AVATARS_SHOWN = 4;

function Developers() {
  const {snapshot, me, identify} = useAlign();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setError('');
    try {
      identify(await api.join({name: trimmed}));
      setName('');
      setOpen(false);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const others = snapshot.developers
    .filter((d) => d.id !== me.id)
    .sort((a, b) => Number(b.online) - Number(a.online))
    .slice(0, AVATARS_SHOWN);

  return (
    <div className="devs" ref={root}>
      <button className="devs-button" aria-label="Developers" aria-expanded={open} onClick={() => setOpen(!open)}>
        {others.map((d) => (
          <Avatar key={d.id} dev={d} />
        ))}
        <Avatar dev={me} current />
        <span className="devs-name">{me.name}</span>
      </button>
      {open && (
        <div className="menu">
          {snapshot.developers.map((d) => (
            <button
              key={d.id}
              className="menu-row"
              onClick={() => {
                identify(d);
                setOpen(false);
              }}
            >
              <Avatar dev={d} />
              <span className="trunc">{d.name}</span>
              {d.id === me.id && <Check size={13} />}
            </button>
          ))}
          <form onSubmit={add}>
            <input className="menu-input" placeholder="Name" aria-label="Name" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} />
          </form>
          {error && <div className="error-line">{error}</div>}
        </div>
      )}
    </div>
  );
}
