import {useEffect, useRef, useState} from 'react';
import type {KeyboardEvent} from 'react';
import {ArrowUp, LoaderCircle} from 'lucide-react';
import type {AgentKind} from '../../shared/types.ts';
import {api, errorText} from './api.ts';
import {useAlign} from './state.ts';
import {AgentMark} from './ui.tsx';

const AGENTS: {kind: AgentKind; label: string}[] = [
  {kind: 'claude', label: 'Claude'},
  {kind: 'codex', label: 'Codex'},
];

export function NewSession({open, onClose}: {open: boolean; onClose: () => void}) {
  const {snapshot, me} = useAlign();
  const {runtime} = snapshot;
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [choice, setChoice] = useState<AgentKind>('claude');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const agent: AgentKind = runtime[choice] ? choice : choice === 'claude' ? 'codex' : 'claude';
  const canSend = runtime[agent] && prompt.trim() !== '' && !busy;

  useEffect(() => {
    const el = dialog.current!;
    if (open && !el.open) {
      el.showModal();
      input.current!.focus();
    }
    if (!open && el.open) el.close();
  }, [open]);

  const submit = async () => {
    if (!canSend) return;
    setBusy(true);
    setError('');
    try {
      const session = await api.createSession({developerId: me.id, agent, prompt: prompt.trim()});
      setPrompt('');
      onClose();
      location.hash = `#/s/${session.id}`;
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <dialog
      ref={dialog}
      className="new"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialog.current) onClose();
      }}
    >
      <div className="new-body">
        <div className="segmented" role="radiogroup" aria-label="Agent">
          {AGENTS.map(({kind, label}) => (
            <button key={kind} role="radio" aria-checked={agent === kind} disabled={!runtime[kind]} onClick={() => setChoice(kind)}>
              <AgentMark agent={kind} />
              {label}
            </button>
          ))}
        </div>
        <textarea ref={input} className="new-prompt" rows={5} placeholder="Prompt" aria-label="Prompt" value={prompt} disabled={busy} onChange={(e) => setPrompt(e.target.value)} onKeyDown={onKeyDown} />
        <div className="new-foot">
          {error && <div className="error-line">{error}</div>}
          <button className="icon solid" aria-label="Send" title="Send" disabled={!canSend} onClick={() => void submit()}>
            {busy ? <LoaderCircle size={14} className="spin" /> : <ArrowUp size={14} />}
          </button>
        </div>
      </div>
    </dialog>
  );
}
