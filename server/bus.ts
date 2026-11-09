import type {App, Bus, SessionRow} from './contracts.ts';
import type {Runtime, ServerEvent, Session, Snapshot} from '../shared/types.ts';

const BROADCAST_INTERVAL_MS = 150;
const SNAPSHOT_ACTIVITY_LIMIT = 200;

type Send = (event: ServerEvent) => void;

function toWireSession({mcpToken: _mcpToken, runnerPid: _runnerPid, ...session}: SessionRow): Session {
  return session;
}

export function createBus(app: App): Bus {
  const runtime: Runtime = {gbrain: 'starting', claude: false, codex: false};
  const connections = new Set<{send: Send}>();
  const presence = new Map<string, number>();
  let timer: NodeJS.Timeout | null = null;
  let lastBroadcast = 0;

  function broadcast(event: ServerEvent): void {
    for (const connection of connections) {
      try {
        connection.send(event);
      } catch (error) {
        console.error('websocket send failed', error);
      }
    }
  }

  function snapshot(): Snapshot {
    const {store, coordination} = app;
    return {
      project: store.getProject(),
      developers: store.listDevelopers().map((developer) => ({...developer, online: presence.has(developer.id)})),
      sessions: store.listSessions().map(toWireSession),
      tasks: store.listTasks(),
      memory: store.listMemory(),
      messages: store.listMessages(),
      impacts: store.listImpacts(),
      files: store.listFiles(),
      issues: coordination.deriveIssues(),
      activity: store.listActivity(SNAPSHOT_ACTIVITY_LIMIT),
      runtime: {...runtime},
    };
  }

  function flushBroadcast(): void {
    timer = null;
    lastBroadcast = Date.now();
    if (connections.size === 0) return;
    try {
      broadcast({type: 'snapshot', data: snapshot()});
    } catch (error) {
      console.error('snapshot failed', error);
    }
  }

  function touch(): void {
    if (timer) return;
    const wait = Math.max(0, lastBroadcast + BROADCAST_INTERVAL_MS - Date.now());
    timer = setTimeout(flushBroadcast, wait);
    timer.unref();
  }

  return {
    touch,

    emit(event) {
      broadcast(event);
    },

    snapshot,

    connect(developerId, send) {
      const connection = {send};
      connections.add(connection);
      if (developerId) presence.set(developerId, (presence.get(developerId) ?? 0) + 1);
      try {
        send({type: 'snapshot', data: snapshot()});
      } catch (error) {
        console.error('snapshot failed', error);
      }
      touch();

      let connected = true;
      return () => {
        if (!connected) return;
        connected = false;
        connections.delete(connection);
        if (developerId) {
          const remaining = (presence.get(developerId) ?? 1) - 1;
          if (remaining > 0) presence.set(developerId, remaining);
          else presence.delete(developerId);
        }
        touch();
      };
    },

    setRuntime(patch) {
      Object.assign(runtime, patch);
      touch();
    },
  };
}
