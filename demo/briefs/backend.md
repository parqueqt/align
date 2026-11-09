Build task updates and persistence in the Taskboard backend (`server.js`, `store.js`).

- Add an endpoint that updates a task's `title` and/or `assignee`, persisted to the data file (`DATA_FILE` or `data/tasks.json`).
- Several people edit the same board at once. Concurrent changes to independent fields must not be silently lost: if one person changes the title and another changes the assignee, both starting from the same loaded task, both changes must survive.
- Concurrent changes to the same field must not silently overwrite each other either: reject the later one with a clear error.
- Keep `GET /api/tasks` working. Add `node --test` tests for your endpoint.

You own the update contract. Publish it to shared memory as a decision (key `task-update-contract`): route, method, request body, conflict behaviour, responses. The frontend agent (Claude) is building the editor right now in parallel and will call your endpoint from `public/api.js` `saveTask(original, draft)`; answer its questions promptly through align and tell it when the contract changes.

No dependencies. When done, commit with `align.commit`.
