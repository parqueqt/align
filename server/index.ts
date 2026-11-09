import {spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import type {App} from './contracts.ts';
import {createBus} from './bus.ts';
import {loadConfig} from './config.ts';
import {createCoordination} from './coordination.ts';
import {createGBrain} from './gbrain.ts';
import {createGit} from './git.ts';
import {createHttpServer} from './http.ts';
import {createMemory} from './memory.ts';
import {createSessions} from './sessions.ts';
import {createStore} from './store.ts';

const SHUTDOWN_TIMEOUT_MS = 15_000;

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true});
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/** Boot repair would kill the runners of an Align already running on this port, so check first. */
function assertPortFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
  });
}

function repairAfterRestart(app: App): void {
  for (const session of app.store.listSessions()) {
    if (session.runnerPid !== null) killTree(session.runnerPid);
    const wasActive = session.status === 'starting' || session.status === 'running';
    // A Codex app-server outlives its turn, so an idle session can hold a pid too.
    if (wasActive || session.runnerPid !== null) {
      app.store.updateSession(session.id, {status: wasActive ? 'idle' : undefined, runnerPid: null});
    }
  }
  app.store.closeOpenItems();
  const unread = app.store.listMessages().filter((message) => message.state === 'delivered' && message.readAt === null);
  if (unread.length > 0) app.coordination.requeue(unread.map((message) => message.id));
}

function startBackgroundWork(app: App): void {
  app.gbrain.start().catch((error: unknown) => console.error('gbrain failed to start', error));
  app.memory.startExternalWatch();
  for (const session of app.store.listSessions()) {
    try {
      app.coordination.flush(session.id);
    } catch (error) {
      console.error(`flush failed for ${session.id}`, error);
    }
  }
}

const app = {} as App;
app.config = loadConfig();
app.store = createStore(app.config);
app.bus = createBus(app);
app.git = createGit();
app.gbrain = createGBrain(app);
app.memory = createMemory(app);
app.coordination = createCoordination(app);
app.sessions = createSessions(app);
app.bus.setRuntime({claude: app.config.claudeBin !== null, codex: app.config.codexBin !== null});

const server = createHttpServer(app);

try {
  await assertPortFree(app.config.port);
} catch (error) {
  console.error(`port ${app.config.port} is not available: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

repairAfterRestart(app);

server.once('error', (error) => {
  console.error(error);
  process.exit(1);
});

server.listen(app.config.port, '127.0.0.1', () => {
  console.log(`align listening on http://127.0.0.1:${app.config.port}`);
  startBackgroundWork(app);
});

let stopping = false;

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
  app.memory.stop();
  await app.sessions.shutdown().catch((error: unknown) => console.error('session shutdown failed', error));
  await app.gbrain.stop().catch((error: unknown) => console.error('gbrain shutdown failed', error));
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
