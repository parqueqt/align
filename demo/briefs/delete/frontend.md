Add a Delete button to each task in the Taskboard list (`public/`), calling the backend's delete endpoint from a new `deleteTask(task)` in `public/api.js`.

What deleting means for users is a product decision that your developer, not you, must make: whether a deleted task is gone for good or can be restored, and whether the user must confirm first. Do not decide it yourself and do not let the backend agent decide it. Record it as a pending human decision with key `task-delete-policy`, ask your developer in this terminal, wait for their answer, and record it.

The backend agent (Codex) is building the delete endpoint in parallel and depends on this decision. Agree the endpoint contract with them through align. Build what does not depend on the decision while you wait.

Vanilla JS only. When done, commit with `align.commit`.
