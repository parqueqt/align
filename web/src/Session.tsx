import {memo, useLayoutEffect, useRef, useState} from 'react';
import type {KeyboardEvent} from 'react';
import {ArrowUp, ChevronRight, CircleAlert, FileText, Link2, LoaderCircle, Pencil, Search, Square, SquareTerminal, Wrench, X} from 'lucide-react';
import type {LucideIcon} from 'lucide-react';
import type {ChatItem, Session, ToolCategory, ToolInfo} from '../../shared/types.ts';
import {api, errorText} from './api.ts';
import {kindLabel, useAlign, useItems} from './state.ts';
import {AgentMark, Md, StatusDot} from './ui.tsx';

function isBusy(session: Session): boolean {
  return session.status === 'running' || session.status === 'starting';
}

export function SessionHeader({session}: {session: Session}) {
  const {me, lookup} = useAlign();
  const task = lookup.tasks.get(session.taskId)?.title ?? session.title;
  return (
    <div className="session-head">
      <AgentMark agent={session.agent} />
      <span className="session-dev">{lookup.developers.get(session.developerId)?.name}</span>
      <span className="session-task trunc" title={task}>
        {task}
      </span>
      <StatusDot status={session.status} />
      {session.status === 'error' && session.statusDetail && (
        <span className="session-error trunc" title={session.statusDetail}>
          {session.statusDetail}
        </span>
      )}
      <code className="session-branch trunc" title={session.worktreePath}>
        {session.branch}
      </code>
      {session.developerId === me.id && isBusy(session) && (
        <button className="icon" aria-label="Stop" title="Stop" onClick={() => void api.interrupt(session.id, me.id).catch(() => {})}>
          <Square size={13} fill="currentColor" />
        </button>
      )}
    </div>
  );
}

export function SessionView({session}: {session: Session}) {
  const {me} = useAlign();
  const items = useItems(session.id);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  return (
    <div className="session">
      <div
        className="chat"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        <div className="chat-column">
          {items.map((item) => (
            <Row key={item.id} item={item} />
          ))}
        </div>
      </div>
      {session.developerId === me.id && <Composer session={session} onSend={() => (atBottom.current = true)} />}
    </div>
  );
}

const Row = memo(function Row({item}: {item: ChatItem}) {
  switch (item.kind) {
    case 'user':
      return <div className="bubble">{item.text}</div>;
    case 'assistant':
      return item.text ? (
        <div className={item.streaming ? 'streaming' : undefined}>
          <Md text={item.text} />
        </div>
      ) : null;
    case 'coordination':
      return <Coordination item={item} />;
    case 'tool':
      return item.tool && <ToolRow tool={item.tool} />;
    case 'error':
      return (
        <div className="item-error">
          <CircleAlert size={14} />
          <span>{item.text}</span>
        </div>
      );
  }
});

function Coordination({item}: {item: ChatItem}) {
  const {lookup} = useAlign();
  const messages = item.messageIds.flatMap((id) => lookup.messages.get(id) ?? []);

  if (messages.length === 0) {
    return (
      <div className="coord">
        <div className="coord-head">
          <Link2 size={13} />
        </div>
        <Md text={item.text} />
      </div>
    );
  }

  return (
    <div className="coord">
      {messages.map((m) => (
        <div key={m.id} className="coord-message">
          <div className="coord-head">
            <Link2 size={13} />
            <span>
              {lookup.handle(m.fromSessionId) ?? 'align'} → {lookup.handle(m.toSessionId)}
            </span>
            <span className="tag">{kindLabel(m.kind)}</span>
          </div>
          <div className="coord-subject">{m.subject}</div>
          {m.body && <Md text={m.body} />}
        </div>
      ))}
    </div>
  );
}

const TOOL_ICONS: Record<ToolCategory, LucideIcon> = {
  shell: SquareTerminal,
  edit: Pencil,
  read: FileText,
  search: Search,
  align: Link2,
  other: Wrench,
};

function ToolRow({tool}: {tool: ToolInfo}) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICONS[tool.category];
  const named = tool.category === 'align' || tool.category === 'other';
  return (
    <div className="tool">
      <button className="tool-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon size={13} className="tool-icon" />
        {named && <span className="tool-name">{tool.name}</span>}
        <span className="trunc">{tool.summary}</span>
        {tool.status === 'running' && <LoaderCircle size={12} className="spin" />}
        {tool.status === 'error' && <X size={12} className="tool-failed" aria-label="Failed" />}
        <ChevronRight size={12} className={`chevron${open ? ' open' : ''}`} />
      </button>
      {open && tool.output && <pre className="tool-output">{tool.output}</pre>}
    </div>
  );
}

function Composer({session, onSend}: {session: Session; onSend: () => void}) {
  const {me} = useAlign();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = input.current!;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const send = async () => {
    const value = text.trim();
    if (!value) return;
    setText('');
    setError('');
    onSend();
    try {
      await api.prompt(session.id, {developerId: me.id, text: value});
    } catch (err) {
      setText(value);
      setError(errorText(err));
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="composer-wrap">
      {error && <div className="error-line">{error}</div>}
      <div className="composer">
        <textarea ref={input} rows={1} placeholder="Message" aria-label="Message" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} />
        <button className="icon solid" aria-label="Send" title="Send" disabled={!text.trim()} onClick={() => void send()}>
          <ArrowUp size={14} />
        </button>
      </div>
    </div>
  );
}
