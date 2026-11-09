# Align demo

Two real agents, each in its own native terminal and git worktree, coordinate through Align's MCP tools and GBrain.

## Prerequisites

Node 24, git, Windows Terminal, Claude Code (`claude`) and Codex CLI (`codex`) signed in, Bun + GBrain (`bun install -g github:garrytan/gbrain#stable`). `npm install` once in this repo.

## Run

```powershell
# terminal 1: the collaboration layer (MCP + GBrain), port 4600
.\align.cmd serve

# terminal 2: prepared taskboard project, two agents, one Windows Terminal window
.\align.cmd demo --reset
```

`demo` copies `demo/taskboard` to `~/align-demo/taskboard`, makes it the project, registers `alice-claude` (frontend, Claude Code) and `bob-codex` (backend, Codex, reasoning effort high), and opens Claude on the left, Codex on the right, and `align watch` below. Each agent only receives its task (`demo/briefs/*.md`); everything after that goes through Align.

Inspect at any time:

```powershell
.\align.cmd status      # agents, tasks, memory, messages
.\align.cmd watch       # live coordination events
```

Check the integrated result (frontend `saveTask` against the backend, two users editing different fields of the same task):

```powershell
node demo/verify.mjs $HOME\.align\worktrees\p1\alice-claude $HOME\.align\worktrees\p1\bob-codex
```

## Game demo: Demo Day Flight (James + Bumsoo)

```powershell
.\align.cmd serve
.\align.cmd demo --reset --scenario flappy
```

Opens "James · Claude Code" (left), "Bumsoo · Codex" (right) and "Align · coordination" (bottom), each window titled with the developer's name. James's agent builds the game logic and the bird and records James's call that the bird is green. Type design requests into Bumsoo's Codex, then "make the bird orange": Align sees that it overrides a decision James approved, marks it as a conflict in shared memory and asks James's agent, which asks James in its terminal. James's answer becomes the decision for both agents.

Other scenarios: `--scenario delete` (a pending product decision), no flag (task editor contract).

## Shared memory

```powershell
.\align.cmd memory --open     # viewer: browse, search, author, history, readers
.\align.cmd memory            # GBrain's own page files, from the terminal
```

GBrain 0.60 has no page browser (its `serve --http` admin dashboard covers OAuth clients, agents and request logs), so Align serves a read-only viewer at `/memory` on its localhost-only server. Content is read live from GBrain. Each Align home has its own GBrain (`<ALIGN_HOME>/gbrain`), separate from any personal brain.

## Own project

```powershell
.\align.cmd serve
.\align.cmd init C:\path\to\repo
.\align.cmd join --name Alice --agent claude --task "..." --brief task.md
.\align.cmd join --name Bob --agent codex --task "..." --brief task.md
.\align.cmd launch alice-claude bob-codex      # or: align run <handle> in any terminal
```

## How messages reach an agent

Neither CLI accepts pushed input, so agents pull: `inbox` returns new messages, `message_wait` blocks until a reply arrives, and every message moves queued → delivered → read → processed. For Claude, hooks also announce waiting messages after each tool call and keep it from stopping while messages are unread.
