# Align

**A shared memory and coordination layer for independent AI coding agents.**

Parallel execution is not collaboration. Align lets Claude Code and Codex, each running in its developer's own terminal, share decisions, message each other, and stay consistent while they work on the same codebase.

```
 James · Claude Code              Bumsoo · Codex
 ┌──────────────────────┐         ┌──────────────────────┐
 │ native terminal      │         │ native terminal      │
 └──────────┬───────────┘         └───────────┬──────────┘
            │              MCP                │
            └────────────┐       ┌────────────┘
                   ┌─────┴───────┴─────┐
                   │       Align       │  tasks · messages · impacts · decisions
                   └─────────┬─────────┘
                             │
                   ┌─────────┴─────────┐
                   │      GBrain       │  shared project memory
                   └───────────────────┘
```

We don't replace coding agents. We make them work together.

## Features

- **Native agents.** Claude Code and Codex run unmodified in their own terminals and git worktrees.
- **Shared memory.** Decisions, contracts and conventions live in [GBrain](https://github.com/garrytan/gbrain), readable by every agent.
- **Agent messaging.** Agents ask, answer and notify each other directly. Every message is tracked from queued to processed.
- **Change propagation.** When a shared decision changes, the agents that depend on it are told, and must adapt and commit or explain why not.
- **Human decisions.** Product calls go to the right developer, in their own agent's terminal. When two developers disagree, Align flags the conflict and asks the one who approved first.
- **Visibility.** Live coordination log in the terminal and a shared memory viewer.

## Quick start

Requirements: Node 24+, Git, [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex), [Bun](https://bun.sh) and GBrain.

```bash
bun install -g github:garrytan/gbrain#stable
git clone https://github.com/parqueqt/align && cd align
npm install && npm link
```

```bash
align serve                                   # start Align (MCP + GBrain)
align init ~/code/my-app                      # the shared project
align join --name James --agent claude --task "Game logic"
align join --name Bumsoo --agent codex --task "Visual design"
align launch james-claude bumsoo-codex        # both agents, side by side
```

Each agent gets its own worktree and a short brief. From there, keep coding in Claude Code or Codex as usual.

To try it with a prepared project, run `align demo --scenario flappy`.

## Commands

| Command | |
| --- | --- |
| `align serve` | Start the collaboration layer |
| `align init <repo>` | Use a git repository as the shared project |
| `align join --name <dev> --agent claude\|codex --task <title>` | Register an agent, its worktree and task |
| `align run <handle>` | Start that agent's CLI, connected |
| `align launch <a> <b>` | Open both agents and the coordination log |
| `align status` | Agents, tasks, memory and messages |
| `align watch` | Live coordination events |
| `align memory [--open]` | Shared memory, in the terminal or the viewer |

## How it works

Align is a local server exposing one MCP endpoint per agent. Agents use it to `sync`, update their task, read and publish shared decisions, message each other (`message_send`, `inbox`, `message_wait`), commit, and record their developer's decisions (`decision_request`, `decision_record`).

Neither CLI accepts pushed input, so agents pull their messages. Claude Code hooks also tell the agent when something is waiting.

Code moves through Git. Knowledge lives in GBrain. Coordination happens through Align.
