import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const file = process.env.DATA_FILE || path.join(import.meta.dirname, 'data', 'tasks.json');

export function listTasks() {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function getTask(id) {
  return listTasks().find(task => task.id === id) ?? null;
}

export function saveAll(tasks) {
  writeFileSync(file, JSON.stringify(tasks, null, 2) + '\n');
}
