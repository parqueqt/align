Build the task editor in the Taskboard frontend (`public/`).

- Each task in the list can be edited: title and assignee, with a Save button.
- Implement `saveTask(original, draft)` in `public/api.js`. Keep that signature: `original` is the task as loaded, `draft` is the edited copy, and it returns the task as saved. It must work in the browser and in Node (`setApiBase`).
- Show a clear message if a save is rejected, and reload the task.
- Several people edit the same board at once. If one person changes a task's title while another changes its assignee, both changes must survive.

The backend update endpoint is being built right now by the backend agent (Codex) in parallel. Its contract (route, method, request body, how concurrent edits are handled, error responses) is theirs to define. Do not guess it: check shared memory and ask the backend agent, then make your implementation match their answer exactly. Start on the UI while you wait.

Vanilla JS only, no dependencies. When done, commit with `align.commit`.
