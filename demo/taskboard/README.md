# Taskboard

A tiny collaborative task board. No dependencies: `npm start`, then open http://localhost:3000.

- `server.js` — HTTP server: static files from `public/`, JSON API under `/api`.
- `store.js` — task persistence in `data/tasks.json` (or `DATA_FILE`).
- `public/api.js` — browser API client (also importable from Node).
- `public/app.js` — UI.

Several people edit the same board at the same time.

## Status

- [x] List tasks (`GET /api/tasks`)
- [ ] Update a task (backend)
- [ ] Task editor: edit title and assignee, save (frontend)
