import {createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore} from 'react';
import type {
  AgentMessage,
  ChatItem,
  Developer,
  Impact,
  ImpactState,
  MessageKind,
  ServerEvent,
  Session,
  Snapshot,
  Task,
} from '../../shared/types.ts';
import {api} from './api.ts';

export type StreamEvent = Exclude<ServerEvent, {type: 'snapshot'}>;
type Listener = (event: StreamEvent) => void;

export function buildLookup(s: Snapshot) {
  const sessions = new Map<string | null, Session>(s.sessions.map((x) => [x.id, x]));
  return {
    sessions,
    tasks: new Map<string | null, Task>(s.tasks.map((x) => [x.id, x])),
    developers: new Map<string | null, Developer>(s.developers.map((x) => [x.id, x])),
    messages: new Map<string | null, AgentMessage>(s.messages.map((x) => [x.id, x])),
    impacts: new Map<string | null, Impact>(s.impacts.map((x) => [x.id, x])),
    handle: (sessionId: string | null) => sessions.get(sessionId)?.handle ?? null,
  };
}
export type Lookup = ReturnType<typeof buildLookup>;

export interface Align {
  snapshot: Snapshot;
  me: Developer;
  lookup: Lookup;
  online: boolean;
  epoch: number;
  subscribe: (fn: Listener) => () => void;
  identify: (dev: Developer) => void;
}

export const AlignContext = createContext<Align | null>(null);

export function useAlign(): Align {
  return useContext(AlignContext)!;
}

const IDENTITY_KEY = 'align.developer';

export function readIdentity(): string | null {
  try {
    return sessionStorage.getItem(IDENTITY_KEY);
  } catch {
    return null;
  }
}

export function writeIdentity(id: string): void {
  try {
    sessionStorage.setItem(IDENTITY_KEY, id);
  } catch {
    // Identity then lasts only as long as this page.
  }
}

export function useConnection(developerId: string | null) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [online, setOnline] = useState(true);
  const [epoch, setEpoch] = useState(0);
  const listeners = useRef(new Set<Listener>());

  useEffect(() => {
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let stopped = false;

    const open = () => {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const query = developerId ? `?dev=${encodeURIComponent(developerId)}` : '';
      socket = new WebSocket(`${scheme}//${location.host}/ws${query}`);
      socket.onopen = () => {
        attempts = 0;
        setOnline(true);
        setEpoch((n) => n + 1);
      };
      socket.onmessage = (message) => {
        const event = JSON.parse(message.data as string) as ServerEvent;
        if (event.type === 'snapshot') setSnapshot(event.data);
        else for (const fn of listeners.current) fn(event);
      };
      socket.onclose = () => {
        if (stopped) return;
        setOnline(false);
        timer = setTimeout(open, Math.min(5000, 300 * 2 ** attempts++));
      };
    };

    open();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [developerId]);

  const subscribe = useCallback((fn: Listener) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  return {snapshot, setSnapshot, online, epoch, subscribe};
}

function streamedLength(item: ChatItem): number {
  return item.tool ? item.tool.output.length : item.text.length;
}

/** A streaming copy from the server may lag deltas this client has already applied. */
function upsert(items: Map<string, ChatItem>, next: ChatItem): void {
  const current = items.get(next.id);
  if (current && next.streaming && streamedLength(current) >= streamedLength(next)) return;
  items.set(next.id, next);
}

function applyDelta(item: ChatItem, text: string): ChatItem {
  return item.tool ? {...item, tool: {...item.tool, output: item.tool.output + text}} : {...item, text: item.text + text};
}

/** Keep the calling component keyed by session id: the item map lives as long as it does. */
export function useItems(sessionId: string): ChatItem[] {
  const {epoch, subscribe} = useAlign();
  const [items, setItems] = useState<ChatItem[]>([]);
  const store = useRef(new Map<string, ChatItem>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const publish = useCallback(() => {
    timer.current = null;
    setItems([...store.current.values()].sort((a, b) => a.seq - b.seq));
  }, []);

  // Must be registered before the fetch below so nothing falls between the two.
  useEffect(() => {
    const unsubscribe = subscribe((event) => {
      if (event.type === 'item') {
        if (event.item.sessionId !== sessionId) return;
        upsert(store.current, event.item);
      } else {
        if (event.sessionId !== sessionId) return;
        const item = store.current.get(event.itemId);
        if (!item) return;
        store.current.set(event.itemId, applyDelta(item, event.text));
      }
      timer.current ??= setTimeout(publish, 33);
    });
    return () => {
      unsubscribe();
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [sessionId, subscribe, publish]);

  useEffect(() => {
    let alive = true;
    api
      .items(sessionId)
      .then((list) => {
        if (!alive) return;
        for (const item of list) upsert(store.current, item);
        publish();
      })
      .catch(() => {
        // The next reconnect fetches again.
      });
    return () => {
      alive = false;
    };
  }, [sessionId, epoch, publish]);

  return items;
}

export type Route = {name: 'overview'} | {name: 'session'; id: string};

function subscribeHash(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribeHash, () => location.hash);
  const match = /^#\/s\/([^/]+)/.exec(hash);
  return match ? {name: 'session', id: decodeURIComponent(match[1])} : {name: 'overview'};
}

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function isOpen(state: ImpactState): boolean {
  return state === 'pending' || state === 'delivered' || state === 'acknowledged';
}

const KIND_LABELS: Partial<Record<MessageKind, string>> = {decision_change: 'decision', task_change: 'task'};

export function kindLabel(kind: MessageKind): string {
  return KIND_LABELS[kind] ?? kind;
}
