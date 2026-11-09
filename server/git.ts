import {execFile} from 'node:child_process';
import {statSync} from 'node:fs';
import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import type {Git} from './contracts.ts';
import type {FileChange, FileState} from '../shared/types.ts';

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_LINE_COUNT_BYTES = 2 * 1024 * 1024;

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function exec(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {cwd, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true}, (error, stdout, stderr) => {
      if (!error) {
        resolve({code: 0, stdout, stderr});
      } else if (typeof error.code === 'number') {
        resolve({code: error.code, stdout, stderr});
      } else {
        reject(error);
      }
    });
  });
}

function failure(result: GitResult): Error {
  return new Error((result.stderr || result.stdout).trim() || `git exited with ${result.code}`);
}

async function run(cwd: string, args: string[]): Promise<string> {
  const result = await exec(cwd, args);
  if (result.code !== 0) throw failure(result);
  return result.stdout;
}

function scanGit(cwd: string, args: string[]): Promise<string> {
  return run(cwd, ['--no-optional-locks', ...args]);
}

function splitNul(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

function identity(authorName: string): string[] {
  // git refuses a name made only of punctuation.
  const name = /[\p{L}\p{N}]/u.test(authorName) ? authorName : 'align';
  return ['-c', `user.name=${name}`, '-c', 'user.email=align@localhost', '-c', 'commit.gpgsign=false'];
}

async function head(worktreePath: string): Promise<string> {
  return (await run(worktreePath, ['rev-parse', 'HEAD'])).trim();
}

function parseNameStatus(output: string): Map<string, FileState> {
  const states = new Map<string, FileState>();
  const tokens = output.split('\0');
  for (let i = 0; i < tokens.length && tokens[i]; ) {
    const code = tokens[i]![0];
    if (code === 'R' || code === 'C') {
      states.set(tokens[i + 2]!, code === 'R' ? 'renamed' : 'added');
      i += 3;
    } else {
      states.set(tokens[i + 1]!, code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified');
      i += 2;
    }
  }
  return states;
}

function parseNumstat(output: string): Map<string, {additions: number; deletions: number}> {
  const counts = new Map<string, {additions: number; deletions: number}>();
  const tokens = output.split('\0');
  for (let i = 0; i < tokens.length && tokens[i]; i++) {
    const [added, deleted, ...rest] = tokens[i]!.split('\t');
    let file = rest.join('\t');
    // With -z a rename is "A\tD\t\0old\0new\0".
    if (file === '') {
      file = tokens[i + 2]!;
      i += 2;
    }
    // Binary files report "-".
    counts.set(file, {additions: Number(added) || 0, deletions: Number(deleted) || 0});
  }
  return counts;
}

interface StatusEntry {
  path: string;
  state: FileState;
  untracked: boolean;
}

function parseStatus(output: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  const tokens = output.split('\0');
  for (let i = 0; i < tokens.length && tokens[i]; i++) {
    const entry = tokens[i]!;
    const x = entry[0];
    const y = entry[1];
    const renamed = x === 'R' || x === 'C' || y === 'R' || y === 'C';
    let state: FileState = 'modified';
    if (entry.startsWith('??') || x === 'A') state = 'added';
    else if (x === 'D' || y === 'D') state = 'deleted';
    else if (renamed) state = 'renamed';
    entries.push({path: entry.slice(3), state, untracked: entry.startsWith('??')});
    // With -z a rename is "XY new\0old\0".
    if (renamed) i++;
  }
  return entries;
}

async function countLines(file: string): Promise<number> {
  try {
    if ((await stat(file)).size > MAX_LINE_COUNT_BYTES) return 0;
    const content = await readFile(file);
    if (content.length === 0 || content.includes(0)) return 0;
    let lines = content[content.length - 1] === 10 ? 0 : 1;
    for (const byte of content) if (byte === 10) lines++;
    return lines;
  } catch {
    return 0;
  }
}

async function scan(worktreePath: string, baseSha: string, sessionId: string): Promise<FileChange[]> {
  // Status runs first: a commit landing mid-scan then shows a file as uncommitted instead of losing it.
  const status = parseStatus(await scanGit(worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
  const [names, numbers] = await Promise.all([
    scanGit(worktreePath, ['diff', '--name-status', '-z', '-M', baseSha]),
    scanGit(worktreePath, ['diff', '--numstat', '-z', '-M', baseSha]),
  ]);

  const uncommitted = new Set(status.map((entry) => entry.path));
  const counts = parseNumstat(numbers);
  const changes = new Map<string, FileChange>();
  for (const [file, state] of parseNameStatus(names)) {
    const {additions, deletions} = counts.get(file) ?? {additions: 0, deletions: 0};
    changes.set(file, {sessionId, path: file, state, additions, deletions, committed: !uncommitted.has(file)});
  }
  for (const entry of status) {
    if (changes.has(entry.path)) continue;
    const additions = entry.untracked ? await countLines(path.join(worktreePath, entry.path)) : 0;
    changes.set(entry.path, {sessionId, path: entry.path, state: entry.state, additions, deletions: 0, committed: false});
  }
  return [...changes.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function createGit(): Git {
  const queues = new Map<string, Promise<unknown>>();
  const scans = new Map<string, {started: number; finished: number; latest: FileChange[]}>();

  function serialized<T>(target: string, operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(target);
    const result = (queues.get(key) ?? Promise.resolve()).then(operation);
    const tail = result.catch(() => {});
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return result;
  }

  return {
    async inspectRepo(repoPath) {
      const dir = path.resolve(repoPath);
      let isDirectory = false;
      try {
        isDirectory = statSync(dir).isDirectory();
      } catch {
        // Reported below.
      }
      if (!isDirectory) throw new Error(`Not a directory: ${dir}`);

      const top = await exec(dir, ['rev-parse', '--show-toplevel']);
      if (top.code !== 0 || !top.stdout.trim()) throw new Error(`Not a git repository: ${dir}`);
      const root = path.resolve(top.stdout.trim());

      const commit = await exec(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
      if (commit.code !== 0) throw new Error(`Repository has no commits: ${root}`);

      // A detached HEAD has no branch name, but its sha still works as the worktree start point.
      const branch = await exec(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
      return {root, name: path.basename(root), baseBranch: (branch.code === 0 ? branch.stdout : commit.stdout).trim()};
    },

    createWorktree(repoPath, baseBranch, branch, worktreePath) {
      return serialized(repoPath, async () => {
        const baseSha = (await run(repoPath, ['rev-parse', '--verify', `${baseBranch}^{commit}`])).trim();
        await run(repoPath, ['worktree', 'add', '-b', branch, worktreePath, baseSha]);
        return baseSha;
      });
    },

    // Scans stay outside the queue so they cannot delay a commit. They may overlap, so a
    // scan that finishes after a newer one hands back the newer result instead of its own.
    async listChanges(worktreePath, baseSha, sessionId) {
      const key = path.resolve(worktreePath);
      let state = scans.get(key);
      if (!state) {
        state = {started: 0, finished: 0, latest: []};
        scans.set(key, state);
      }
      const ticket = ++state.started;
      const files = await scan(worktreePath, baseSha, sessionId);
      if (ticket < state.finished) return state.latest;
      state.finished = ticket;
      state.latest = files;
      return files;
    },

    commit(worktreePath, message, authorName) {
      return serialized(worktreePath, async () => {
        await run(worktreePath, ['add', '-A']);
        const files = splitNul(await run(worktreePath, ['diff', '--cached', '--name-only', '--no-renames', '-z']));
        if (files.length === 0) return null;
        await run(worktreePath, [...identity(authorName), 'commit', '-m', message]);
        return {sha: await head(worktreePath), files};
      });
    },

    merge(worktreePath, branch, authorName) {
      return serialized(worktreePath, async () => {
        if (branch.startsWith('-')) throw new Error(`Invalid branch: ${branch}`);
        const before = await head(worktreePath);
        const result = await exec(worktreePath, [...identity(authorName), 'merge', '--no-edit', branch]);
        if (result.code === 0) {
          const after = await head(worktreePath);
          if (after === before) return {status: 'up_to_date'};
          const files = splitNul(await run(worktreePath, ['diff', '--name-only', '--no-renames', '-z', before, after]));
          return {status: 'merged', sha: after, files};
        }

        // Without MERGE_HEAD git refused before starting (unknown branch, local changes in the way).
        const merging = await exec(worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
        if (merging.code !== 0) throw failure(result);
        const paths = splitNul(await run(worktreePath, ['diff', '--name-only', '--diff-filter=U', '-z']));
        await run(worktreePath, ['merge', '--abort']);
        if (paths.length === 0) throw failure(result);
        return {status: 'conflict', paths};
      });
    },

    headSha(worktreePath) {
      return serialized(worktreePath, () => head(worktreePath));
    },
  };
}
