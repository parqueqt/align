import {spawn, spawnSync} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import path from 'node:path';

const SHUTDOWN_GRACE_MS = 8_000;

const root = path.resolve(import.meta.dirname, '..');
const children: ChildProcess[] = [
  spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--watch', 'server/index.ts'], {cwd: root, stdio: 'inherit'}),
  spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')], {cwd: root, stdio: 'inherit'}),
];

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true});
  } else {
    child.kill('SIGTERM');
  }
}

let stopping = false;

function stop(exitCode: number, graceMs: number): void {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  setTimeout(() => children.forEach(killTree), graceMs).unref();
}

for (const child of children) {
  child.on('error', (error) => {
    console.error(error);
    stop(1, 0);
  });
  child.on('exit', (code) => stop(code ?? 1, 0));
}

// Ctrl-C reaches the children directly; the wait lets the server stop its agents and GBrain.
process.on('SIGINT', () => stop(0, SHUTDOWN_GRACE_MS));
process.on('SIGTERM', () => stop(0, 0));
