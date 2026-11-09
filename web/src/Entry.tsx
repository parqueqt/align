import {useState} from 'react';
import type {FormEvent} from 'react';
import type {Developer} from '../../shared/types.ts';
import {api, errorText} from './api.ts';

function CenteredInput({placeholder, wordmark, onSubmit}: {placeholder: string; wordmark?: boolean; onSubmit: (value: string) => Promise<void>}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(trimmed);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="entry" onSubmit={submit}>
      {wordmark && <div className="wordmark entry-word">align</div>}
      <input
        className="entry-input"
        autoFocus
        spellCheck={false}
        placeholder={placeholder}
        aria-label={placeholder}
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
      />
      {error && <div className="error-line">{error}</div>}
    </form>
  );
}

export function Join({onJoin}: {onJoin: (dev: Developer) => void}) {
  return <CenteredInput wordmark placeholder="Name" onSubmit={async (name) => onJoin(await api.join({name}))} />;
}

export function ProjectScreen() {
  return (
    <CenteredInput
      placeholder="Path"
      onSubmit={async (repoPath) => {
        await api.setProject({repoPath});
      }}
    />
  );
}
