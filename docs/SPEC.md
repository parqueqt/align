# Align — Product Spec

**A shared memory and coordination layer for independent AI coding agents.**

Core concept: **Parallel execution ≠ Collaboration.** Principle: **We don't replace coding agents. We make them work together.**

User experience: *Install once. Keep coding in Claude Code or Codex. Your agents coordinate behind the scenes.*

This supersedes the earlier standalone AI Coding Workspace direction. The managed chat UI and agent runners remain recoverable at git tag `workspace-ui-v0`.

## 1. Product architecture

A lightweight, independently usable CLI + MCP collaboration layer. Developers keep working in Claude Code and OpenAI Codex terminals. Align provides the infrastructure connecting them; it never replaces their native interfaces, and recreates no chat, streaming, or execution environment.

## 2. CLI experience

Developers can, with minimal configuration: initialize collaboration for an existing project; connect Claude Code and Codex; register participating agents and tasks; start and use the infrastructure; keep developing through normal terminal workflows; inspect status and activity when necessary. No web application is required for core functionality.

## 3. Coordination engine (core differentiator)

Task awareness and registration; shared task dependencies; agent-to-agent messaging; shared context synchronization; change impact detection; coordination of dependent work; conflict detection and escalation; human decision handling; verification of coordination outcomes.

The engine determines when information needs to be shared, which agents are affected, and whether an issue can be resolved autonomously or needs human input. It avoids unnecessary coordination between unrelated tasks.

## 4. Shared memory — GBrain

GBrain is the shared memory across Claude Code and Codex sessions. Agents publish and retrieve architectural decisions, technical conventions, interface contracts, important implementation decisions, and shared project context. GBrain is the memory layer, not the entire coordination system.

## 5. Agent-to-agent communication

Agents communicate about implementation details without developers relaying messages: requesting details of another agent's implementation, confirming interface or schema definitions, communicating changes to shared modules, resolving routine technical disagreements, coordinating dependent tasks, and requesting clarification about progress.

Messages must be consumed and acted upon by the receiving agent. Storing a message is not successful communication. The system provides a reliable way for agents to check, receive, and process coordination messages during ongoing work.

## 6. Human-in-the-loop decisions

There is no separate approval inbox. When a decision needs human judgment, the relevant agent asks its own developer directly in its existing Claude Code or Codex terminal conversation.

Requires a human: conflicting explicit user requirements; important product or design decisions; significant architectural changes; changes overriding previously approved decisions; unresolved disagreements requiring human preference; high-risk or irreversible actions. Routine technical details are resolved autonomously between agents.

Human decisions are recorded and communicated to relevant agents, and important approved decisions are preserved in GBrain. The system must not assume an MCP server can inject messages or interactive approval prompts into a running session; the workflow must be reliable with what the supported agents actually provide. Only work dependent on an unresolved approval is blocked, where possible.

## 7. Git and worktrees

Git remains the source-code version control and integration mechanism. Align supports agents in separate worktrees or independent working directories of the same project, and maintains the distinction between code synchronization (Git), shared knowledge (GBrain), and coordination (Align). No custom merge engine. The focus is identifying and addressing semantic inconsistencies before integration.

## 8. Visibility (optional, lightweight)

Users can inspect active agents and tasks, agent-to-agent messages, shared context updates, coordination events, pending human decisions, and resolved coordination issues, through CLI output or a minimal viewer. Visualization never delays core coordination. UI directive for any viewer: bright, clean, no explanatory or unnecessary text, as simple as possible.

## 9. Constraints

Single laptop. Orca ADE is a development environment only; the product is independent of it. Separate from Nabla (never modify it). No unnecessary cloud infrastructure or production authentication.

## 10. Priorities

1. Working Claude Code and Codex integration.
2. CLI + MCP collaboration infrastructure.
3. GBrain shared memory.
4. Reliable agent-to-agent messaging.
5. Task awareness and dependency tracking.
6. Cross-agent coordination and change propagation.
7. Human decision escalation through native agent conversations.
8. Verification of actual coordination outcomes.
9. Optional lightweight coordination visualization.

## 11. Definition of Done

- Claude Code and Codex operate independently using their native terminal interfaces.
- Both agents connect to the same collaboration layer.
- Their tasks and dependencies are discoverable.
- Shared technical decisions can be stored and retrieved through GBrain.
- Agents can exchange relevant messages and act on them.
- One agent's important decision can influence another agent's ongoing coding work.
- Important unresolved decisions can be escalated to the appropriate developer through the agent's native conversation.
- Approved decisions can be shared with affected agents.
- Actual changes in agent behavior or code can be verified.

Successful real-time coordination is never claimed when a message has only been queued.
