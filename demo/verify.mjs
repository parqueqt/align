// Integration check of the two agents' merged work: frontend saveTask against the real backend.
// Usage: node demo/verify.mjs <frontend-worktree> <backend-worktree>
import {spawn, execFileSync} from 'node:child_process';
import {cpSync, mkdtempSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const [frontend, backend] = process.argv.slice(2).map(p => path.resolve(p));
const work = mkdtempSync(path.join(tmpdir(), 'taskboard-verify-'));
// Backend code from the backend worktree, frontend code from the frontend worktree, as committed.
for (const [src, sub] of [[backend, ''], [frontend, 'public']]) {
  const files = execFileSync('git', ['ls-files', sub || '.'], {cwd: src, encoding: 'utf8'}).split('\n').filter(Boolean);
  for (const f of files) cpSync(path.join(src, f), path.join(work, f));
}
const dataFile = path.join(work, 'verify-tasks.json');
writeFileSync(dataFile, readFileSync(path.join(work, 'data', 'tasks.json')));
const port = 3900 + Math.floor(Math.random() * 90);
const server = spawn(process.execPath, ['server.js'], {cwd: work, env: {...process.env, PORT: String(port), DATA_FILE: dataFile}, stdio: ['ignore', 'pipe', 'pipe']});
const stop = () => server.kill();
const check = (ok, label, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); return ok; };

try {
  for (let i = 0; ; i++) {
    try { await fetch(`http://127.0.0.1:${port}/api/tasks`); break; } catch { if (i > 50) throw new Error('backend did not start'); await new Promise(r => setTimeout(r, 200)); }
  }
  const api = await import(pathToFileURL(path.join(work, 'public', 'api.js')).href);
  api.setApiBase(`http://127.0.0.1:${port}`);

  const [loadedA] = (await api.fetchTasks()).filter(t => t.id === '1');
  const [loadedB] = (await api.fetchTasks()).filter(t => t.id === '1');
  const results = [];
  results.push(check(!!loadedA, 'frontend loads tasks from backend'));

  // Two users start from the same loaded task and change different fields.
  const savedA = await api.saveTask(loadedA, {...loadedA, title: 'Write onboarding guide v2'});
  results.push(check(savedA?.title === 'Write onboarding guide v2', 'user A saves a title change'));
  let savedB, errB;
  try { savedB = await api.saveTask(loadedB, {...loadedB, assignee: 'Hyun'}); } catch (e) { errB = e; }
  results.push(check(!errB, 'user B saves an assignee change from the same loaded version', errB ? String(errB.message) : ''));

  const final = (await api.fetchTasks()).find(t => t.id === '1');
  results.push(check(final.title === 'Write onboarding guide v2' && final.assignee === 'Hyun', 'both independent field changes are preserved', JSON.stringify(final)));
  const persisted = JSON.parse(readFileSync(dataFile, 'utf8')).find(t => t.id === '1');
  results.push(check(persisted.title === final.title && persisted.assignee === final.assignee, 'changes persisted to the data file'));

  // Same field, same base: the later save must not silently win.
  const [c1] = (await api.fetchTasks()).filter(t => t.id === '2');
  await api.saveTask(c1, {...c1, title: 'Fix login redirect (A)'});
  let errC;
  try { await api.saveTask(c1, {...c1, title: 'Fix login redirect (B)'}); } catch (e) { errC = e; }
  const t2 = (await api.fetchTasks()).find(t => t.id === '2');
  results.push(check(!!errC && t2.title === 'Fix login redirect (A)', 'conflicting edit to the same field is rejected, not silently overwritten', errC ? String(errC.message) : JSON.stringify(t2)));

  console.log(results.every(Boolean) ? '\nINTEGRATION PASS' : '\nINTEGRATION FAIL');
  process.exitCode = results.every(Boolean) ? 0 : 1;
} catch (error) {
  console.log('FAIL ', String(error?.stack ?? error));
  process.exitCode = 1;
} finally {
  stop();
}
