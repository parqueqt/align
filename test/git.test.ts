import assert from 'node:assert/strict';
import childProcess, {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, test} from 'node:test';
import {createGit} from '../server/git.ts';

const SESSION = 'S1';

let dir: string;
let repo: string;
const git = createGit();

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
}

function write(root: string, file: string, content: string): void {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), {recursive: true});
  writeFileSync(target, content);
}

function find<T extends {path: string}>(files: T[], file: string): T {
  const entry = files.find((f) => f.path === file);
  assert.ok(entry, `missing ${file} in ${files.map((f) => f.path).join(', ')}`);
  return entry;
}

async function worktree(name: string): Promise<{path: string; branch: string; baseSha: string}> {
  const worktreePath = path.join(dir, 'work trees', name);
  const branch = `align/${name}`;
  const baseSha = await git.createWorktree(repo, 'main', branch, worktreePath);
  return {path: worktreePath, branch, baseSha};
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'align git ')));
  repo = path.join(dir, 'my repo');
  mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.name', 'Test');
  sh(repo, 'config', 'user.email', 'test@example.com');
  sh(repo, 'config', 'commit.gpgsign', 'false');
  write(repo, 'README.md', 'one\ntwo\nthree\n');
  write(repo, 'shared.txt', 'base\n');
  write(repo, 'gone.txt', 'bye\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'init');
});

afterEach(() => {
  rmSync(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
});

test('inspectRepo returns root, name and branch, from a subdirectory too', async () => {
  const expected = {root: repo, name: 'my repo', baseBranch: 'main'};
  const normalize = (r: {root: string; name: string; baseBranch: string}) => ({...r, root: realpathSync(r.root)});
  assert.deepEqual(normalize(await git.inspectRepo(repo)), expected);

  write(repo, 'sub/file.txt', 'x');
  assert.deepEqual(normalize(await git.inspectRepo(path.join(repo, 'sub'))), expected);
});

test('inspectRepo rejects missing paths, non-repos and repos with no commits', async () => {
  await assert.rejects(git.inspectRepo(path.join(dir, 'missing')), /Not a directory/);

  const plain = path.join(dir, 'plain dir');
  mkdirSync(plain);
  await assert.rejects(git.inspectRepo(plain), /Not a git repository/);

  const empty = path.join(dir, 'empty repo');
  mkdirSync(empty);
  sh(empty, 'init', '-q');
  await assert.rejects(git.inspectRepo(empty), /no commits/);
});

test('inspectRepo uses the sha as base on a detached HEAD', async () => {
  const sha = sh(repo, 'rev-parse', 'HEAD');
  sh(repo, 'checkout', '-q', '--detach');
  assert.equal((await git.inspectRepo(repo)).baseBranch, sha);
});

test('createWorktree works with spaces in the repo and worktree paths', async () => {
  const baseSha = sh(repo, 'rev-parse', 'main');
  const tree = await worktree('alice-claude');

  assert.equal(tree.baseSha, baseSha);
  assert.equal(sh(tree.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'align/alice-claude');
  assert.equal(await git.headSha(tree.path), baseSha);
  assert.equal(readFileSync(path.join(tree.path, 'README.md'), 'utf8').replaceAll('\r\n', '\n'), 'one\ntwo\nthree\n');
  assert.deepEqual(await git.listChanges(tree.path, tree.baseSha, SESSION), []);
});

test('createWorktree rejects an existing branch', async () => {
  await worktree('dup');
  await assert.rejects(git.createWorktree(repo, 'main', 'align/dup', path.join(dir, 'other')), /already exists/);
});

test('listChanges merges committed and uncommitted changes with forward-slash paths', async () => {
  const tree = await worktree('scan');
  write(tree.path, 'src/deep/committed.ts', 'a\nb\n');
  await git.commit(tree.path, 'add committed', 'Alice');

  write(tree.path, 'README.md', 'one\nTWO\nthree\nfour\n');
  write(tree.path, 'src/deep/new file.txt', 'x\ny');
  rmSync(path.join(tree.path, 'gone.txt'));

  const files = await git.listChanges(tree.path, tree.baseSha, SESSION);
  assert.deepEqual(
    files.map((f) => f.path),
    ['README.md', 'gone.txt', 'src/deep/committed.ts', 'src/deep/new file.txt'],
  );
  assert.ok(files.every((f) => f.sessionId === SESSION && !f.path.includes('\\')));

  assert.deepEqual(find(files, 'src/deep/committed.ts'), {sessionId: SESSION, path: 'src/deep/committed.ts', state: 'added', additions: 2, deletions: 0, committed: true});
  assert.deepEqual(find(files, 'README.md'), {sessionId: SESSION, path: 'README.md', state: 'modified', additions: 2, deletions: 1, committed: false});
  assert.deepEqual(find(files, 'gone.txt'), {sessionId: SESSION, path: 'gone.txt', state: 'deleted', additions: 0, deletions: 1, committed: false});
  assert.deepEqual(find(files, 'src/deep/new file.txt'), {sessionId: SESSION, path: 'src/deep/new file.txt', state: 'added', additions: 2, deletions: 0, committed: false});
});

test('listChanges marks a committed file with further edits as uncommitted', async () => {
  const tree = await worktree('both');
  write(tree.path, 'a.txt', 'one\n');
  await git.commit(tree.path, 'a', 'Alice');
  write(tree.path, 'a.txt', 'one\ntwo\n');

  const [entry] = await git.listChanges(tree.path, tree.baseSha, SESSION);
  assert.equal(entry?.state, 'added');
  assert.equal(entry?.additions, 2);
  assert.equal(entry?.committed, false);
});

test('listChanges reports renames under the new path', async () => {
  const tree = await worktree('rename');
  sh(tree.path, 'mv', 'README.md', 'docs.md');
  await git.commit(tree.path, 'rename', 'Alice');

  const files = await git.listChanges(tree.path, tree.baseSha, SESSION);
  assert.deepEqual(files.map((f) => [f.path, f.state, f.committed]), [['docs.md', 'renamed', true]]);
});

test('listChanges does not quote non-ASCII paths', async () => {
  const tree = await worktree('names');
  write(tree.path, '目录/naïve file.txt', 'x\n');
  const [entry] = await git.listChanges(tree.path, tree.baseSha, SESSION);
  assert.equal(entry?.path, '目录/naïve file.txt');
  assert.equal(entry?.additions, 1);
});

test('listChanges does not touch the index', async () => {
  const tree = await worktree('locks');
  write(tree.path, 'README.md', 'changed\n');
  const gitDir = sh(tree.path, 'rev-parse', '--absolute-git-dir');
  const index = path.join(gitDir, 'index');
  const before = readFileSync(index);
  await git.listChanges(tree.path, tree.baseSha, SESSION);
  assert.deepEqual(readFileSync(index), before);
});

test('overlapping scans all resolve, and later callers see the latest state', async () => {
  const tree = await worktree('overlap');
  write(tree.path, 'a.txt', 'a\n');
  const results = await Promise.all(Array.from({length: 8}, () => git.listChanges(tree.path, tree.baseSha, SESSION)));
  for (const files of results) assert.deepEqual(files.map((f) => f.path), ['a.txt']);

  write(tree.path, 'b.txt', 'b\n');
  const latest = await git.listChanges(tree.path, tree.baseSha, SESSION);
  assert.deepEqual(latest.map((f) => f.path), ['a.txt', 'b.txt']);
});

test('a scan that finishes after a newer scan returns the newer result', async () => {
  const tree = await worktree('stale');
  write(tree.path, 'old.txt', 'old\n');

  let releaseHeld = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  let statusHeld = false;
  const realExecFile = childProcess.execFile;
  // Holds the first scan's `git status` result so the second scan overtakes it.
  const holdingExecFile = (file: string, args: string[], options: object, callback: (...result: unknown[]) => void) =>
    (realExecFile as unknown as (...params: unknown[]) => unknown)(file, args, options, (...result: unknown[]) => {
      if (args.includes('status') && !statusHeld) {
        statusHeld = true;
        void gate.then(() => callback(...result));
        return;
      }
      callback(...result);
    });
  (childProcess as unknown as {execFile: unknown}).execFile = holdingExecFile;
  syncBuiltinESMExports();
  try {
    const stale = git.listChanges(tree.path, tree.baseSha, SESSION);
    while (!statusHeld) await new Promise((resolve) => setTimeout(resolve, 10));

    write(tree.path, 'new.txt', 'new\n');
    const fresh = await git.listChanges(tree.path, tree.baseSha, SESSION);
    assert.deepEqual(fresh.map((f) => f.path), ['new.txt', 'old.txt']);

    releaseHeld();
    assert.deepEqual(await stale, fresh);
  } finally {
    childProcess.execFile = realExecFile;
    syncBuiltinESMExports();
  }
});

test('commit stages everything, uses the given author, and returns null when clean', async () => {
  const tree = await worktree('commit');
  write(tree.path, 'src/one.ts', '1\n');
  write(tree.path, 'README.md', 'changed\n');
  rmSync(path.join(tree.path, 'gone.txt'));

  const result = await git.commit(tree.path, 'first line\n\nbody with "quotes"', 'Alice Smith');
  assert.ok(result);
  assert.equal(result.sha, sh(tree.path, 'rev-parse', 'HEAD'));
  assert.deepEqual([...result.files].sort(), ['README.md', 'gone.txt', 'src/one.ts']);
  assert.equal(sh(tree.path, 'log', '-1', '--format=%an'), 'Alice Smith');
  assert.equal(sh(tree.path, 'log', '-1', '--format=%s'), 'first line');
  assert.equal(sh(tree.path, 'log', '-1', '--format=%ae'), 'align@localhost');
  assert.equal(sh(tree.path, 'status', '--porcelain'), '');

  assert.equal(await git.commit(tree.path, 'nothing', 'Alice'), null);
  assert.equal(await git.headSha(tree.path), result.sha);
});

test('commit falls back when the author name has no letters or digits', async () => {
  const tree = await worktree('punct');
  write(tree.path, 'a.txt', '1\n');
  assert.ok(await git.commit(tree.path, 'x', '...'));
  assert.equal(sh(tree.path, 'log', '-1', '--format=%an'), 'align');
});

test('operations on one worktree are serialized while scans run alongside', async () => {
  const tree = await worktree('serial');
  write(tree.path, 'a.txt', '1\n');
  const [first, second, , head] = await Promise.all([
    git.commit(tree.path, 'one', 'Alice'),
    git.commit(tree.path, 'two', 'Alice'),
    git.listChanges(tree.path, tree.baseSha, SESSION),
    git.headSha(tree.path),
  ]);
  assert.ok(first);
  assert.equal(second, null);
  assert.equal(head, first.sha);
});

test('a failed operation does not block the queue', async () => {
  const tree = await worktree('recover');
  await assert.rejects(git.merge(tree.path, 'no-such-branch', 'Alice'));
  write(tree.path, 'a.txt', '1\n');
  assert.ok(await git.commit(tree.path, 'after failure', 'Alice'));
});

test('merge brings in a peer branch and reports up_to_date afterwards', async () => {
  const a = await worktree('a');
  const b = await worktree('b');
  write(a.path, 'from-a.txt', 'a\n');
  const committed = await git.commit(a.path, 'a work', 'Alice');
  assert.ok(committed);
  write(b.path, 'from-b.txt', 'b\n');
  await git.commit(b.path, 'b work', 'Bob');

  const merged = await git.merge(b.path, a.branch, 'Bob');
  assert.equal(merged.status, 'merged');
  assert.ok(merged.status === 'merged');
  assert.equal(merged.sha, sh(b.path, 'rev-parse', 'HEAD'));
  assert.deepEqual(merged.files, ['from-a.txt']);
  assert.equal(sh(b.path, 'log', '-1', '--format=%an'), 'Bob');
  assert.equal(readFileSync(path.join(b.path, 'from-a.txt'), 'utf8').replaceAll('\r\n', '\n'), 'a\n');

  assert.deepEqual(await git.merge(b.path, a.branch, 'Bob'), {status: 'up_to_date'});
});

test('merge fast-forwards when the branch has no work of its own', async () => {
  const a = await worktree('ff-a');
  const b = await worktree('ff-b');
  write(a.path, 'x.txt', 'x\n');
  const committed = await git.commit(a.path, 'x', 'Alice');
  assert.ok(committed);

  assert.deepEqual(await git.merge(b.path, a.branch, 'Bob'), {status: 'merged', sha: committed.sha, files: ['x.txt']});
});

test('merge conflict aborts and leaves the worktree as it was', async () => {
  const a = await worktree('left');
  const b = await worktree('right');
  write(a.path, 'shared.txt', 'left\n');
  write(a.path, 'clean.txt', 'merges fine\n');
  await git.commit(a.path, 'left', 'Alice');
  write(b.path, 'shared.txt', 'right\n');
  await git.commit(b.path, 'right', 'Bob');
  const before = sh(b.path, 'rev-parse', 'HEAD');

  assert.deepEqual(await git.merge(b.path, a.branch, 'Bob'), {status: 'conflict', paths: ['shared.txt']});

  assert.equal(sh(b.path, 'rev-parse', 'HEAD'), before);
  assert.equal(sh(b.path, 'status', '--porcelain'), '');
  assert.throws(() => sh(b.path, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'));
  assert.equal(readFileSync(path.join(b.path, 'shared.txt'), 'utf8').replaceAll('\r\n', '\n'), 'right\n');
});

test('merge throws without touching the worktree when git refuses to start', async () => {
  const a = await worktree('dirty-a');
  const b = await worktree('dirty-b');
  write(a.path, 'shared.txt', 'theirs\n');
  await git.commit(a.path, 'theirs', 'Alice');
  write(b.path, 'shared.txt', 'local edit\n');

  await assert.rejects(git.merge(b.path, a.branch, 'Bob'), /overwritten/);
  assert.equal(readFileSync(path.join(b.path, 'shared.txt'), 'utf8').replaceAll('\r\n', '\n'), 'local edit\n');

  await assert.rejects(git.merge(b.path, '--strategy=ours', 'Bob'), /Invalid branch/);
});
