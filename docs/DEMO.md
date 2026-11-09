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
