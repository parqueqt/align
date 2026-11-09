// API client. Works in the browser (relative URLs) and in Node (call setApiBase first).
let base = '';

export function setApiBase(url) {
  base = url.replace(/\/$/, '');
}

export async function fetchTasks() {
  const res = await fetch(`${base}/api/tasks`);
  if (!res.ok) throw new Error(`load failed: ${res.status}`);
  return res.json();
}

/**
 * Saves the user's edits.
 * @param original the task as it was loaded, before editing
 * @param draft the edited copy
 * @returns the task as saved by the server
 */
export async function saveTask(original, draft) {
  // TODO(frontend): call the backend's update endpoint.
  throw new Error('not implemented');
}
