import {mkdirSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import type {Config} from './contracts.ts';

const isWindows = process.platform === 'win32';
const CODEX_NPM_EXE = '@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe';

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function pathDirs(): string[] {
  return (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
}

// Children are spawned without a shell, so on Windows only a real .exe qualifies, never a .cmd shim.
function findOnPath(name: string): string | null {
  const fileName = isWindows ? `${name}.exe` : name;
  for (const dir of pathDirs()) {
    const candidate = path.resolve(dir, fileName);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function firstFile(candidates: string[]): string | null {
  return candidates.find(isFile) ?? null;
}

function resolveBin(envName: string, discover: () => string | null): string | null {
  const override = process.env[envName];
  if (override) {
    const file = path.resolve(override);
    return isFile(file) ? file : null;
  }
  return discover();
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

export function loadConfig(): Config {
  const home = homedir();
  const appData = process.env.APPDATA;
  const alignHome = path.resolve(process.env.ALIGN_HOME || path.join(home, '.align'));
  const worktreesDir = path.join(alignHome, 'worktrees');
  const gbrainHome = path.join(alignHome, 'gbrain');
  for (const dir of [alignHome, worktreesDir, gbrainHome]) mkdirSync(dir, {recursive: true});

  const bunBin = resolveBin('ALIGN_BUN', () => {
    const exe = isWindows ? 'bun.exe' : 'bun';
    const npmBun = appData ? [path.join(appData, 'npm', 'node_modules', 'bun', 'bin', 'bun.exe')] : [];
    return findOnPath('bun') ?? firstFile([...npmBun, path.join(home, '.bun', 'bin', exe)]);
  });

  const gbrainCli = resolveBin('ALIGN_GBRAIN_CLI', () =>
    firstFile([path.join(home, '.bun', 'install', 'global', 'node_modules', 'gbrain', 'src', 'cli.ts')]),
  );

  const claudeBin = resolveBin('ALIGN_CLAUDE_BIN', () =>
    findOnPath('claude') ?? firstFile([path.join(home, '.local', 'bin', isWindows ? 'claude.exe' : 'claude')]),
  );

  const codexBin = resolveBin('ALIGN_CODEX_BIN', () => {
    const onPath = findOnPath('codex');
    if (onPath || !isWindows) return onPath;
    const npmDirs = [...(appData ? [path.join(appData, 'npm')] : []), ...pathDirs()];
    return firstFile(npmDirs.map((dir) => path.resolve(dir, 'node_modules', CODEX_NPM_EXE)));
  });

  return {
    home: alignHome,
    dbPath: path.join(alignHome, 'align.db'),
    worktreesDir,
    gbrainHome,
    port: intEnv('ALIGN_PORT', 4600),
    bunBin,
    gbrainCli,
    claudeBin,
    codexBin,
    claudeModel: process.env.ALIGN_CLAUDE_MODEL || null,
    codexModel: process.env.ALIGN_CODEX_MODEL || null,
    codexEffort: process.env.ALIGN_CODEX_EFFORT || 'medium',
    maxAutoTurns: intEnv('ALIGN_MAX_AUTO_TURNS', 8),
  };
}
