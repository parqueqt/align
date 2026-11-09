# Align — Product Spec

Align is a functional multiplayer AI coding workspace that enables independent coding agents to collaborate on the same software project.

Core concept: **Visibility ≠ Collaboration.** Running multiple agents and observing their sessions does not guarantee that they can collaborate. The goal is to enable independently operated agents to understand each other's work, share knowledge, coordinate dependent tasks, and maintain consistency across a shared codebase.

## UI directive (from the product owner)

Bright and clean. No explanatory text or unnecessary text anywhere. As simple as possible.

## 1. Real Coding Agent Integration

Support Claude Code and OpenAI Codex.

- Fully functional agent chat interfaces.
- Users send prompts, receive responses, and execute real coding tasks.
- Parallel execution and independent agent sessions.
- Display agent responses, tool activities, and execution progress.
- Continued conversations within existing sessions.
- Agents work on the same project using isolated working environments.
- Each execution is clearly associated with its developer, agent, session, and task.

The system must use real coding agents rather than simulated responses.

## 2. Multiplayer Workspace

- Shared workspace for multiple developers on the same project.
- Distinguish developers, agents, and sessions.
- Each developer interacts with their own coding agent.
- Relevant agent activities are visible to other participants.
- Shared project awareness without requiring developers to use the same agent session.
- Lightweight demonstration identity mechanism (no production authentication).

## 3. Task Awareness and Dependency Tracking

- Register and update agent tasks.
- Track task ownership and execution status.
- Agents can discover other agents' tasks.
- Associate tasks with relevant files, working directories, and Git worktrees.
- Represent dependencies between tasks and shared project decisions.
- Identify when changes made by one agent may affect another agent's work.
- Make related, overlapping, or potentially conflicting work visible.

Prioritize reliable coordination of known dependencies rather than complex autonomous dependency inference.

## 4. Shared Memory — GBrain

Use GBrain as the shared agent memory system.

- Claude Code and Codex access shared project knowledge.
- Agents publish and retrieve technical decisions, architectural conventions, project rules, and relevant context.
- Knowledge sharing across independent sessions.
- Important memory updates are visible.
- Agents retrieve relevant and up-to-date project information.
- Avoid unnecessarily sharing complete conversation histories.

GBrain is the shared knowledge layer. Align decides how that knowledge supports coordination between agents.

## 5. Agent-to-Agent Messaging

- Send and receive messages between agents.
- Request information or clarification.
- Notify other agents about important changes.
- Communicate decisions affecting related tasks.
- Support coordination requests and responses.
- Track message delivery and processing states.
- Allow messages to influence actual coding behavior.

Agent communication must support meaningful collaboration, not merely display messages.

## 6. Cross-Agent Coordination Engine (central differentiator)

- Maintain awareness of parallel tasks and their dependencies.
- Recognize when a shared decision changes.
- Identify agents whose tasks depend on the updated information.
- Notify affected agents.
- Allow agents to retrieve updated context and adapt their work.
- Track acknowledgments and relevant coordination outcomes.
- Reduce duplicated work, inconsistent implementations, and avoidable integration problems.
- Help agents maintain alignment while working independently.

The objective is to prevent avoidable semantic conflicts rather than automatically resolve all Git merge conflicts.

## 7. Functional Agent Chat UI

- Real conversations with coding agents.
- Prompt input and streamed responses.
- Agent execution progress and relevant tool activity.
- Session status and task information.
- Continued interaction with existing sessions.
- Clear distinction between user messages and agent-to-agent coordination messages.
- Intuitive navigation between agent sessions.

## 8. Collaboration Dashboard

Real-time dashboard showing: active developers and agents; current tasks and execution status; agent sessions and worktrees; relevant file modifications; task dependencies; shared memory changes; agent-to-agent messages; coordination events; potential inconsistencies; coordination outcomes.

Prioritize clarity, usability, and visual understanding of cross-agent collaboration. Emphasize meaningful collaboration events rather than raw logs.

## 9. Development Environment

- Single laptop; independently usable outside Orca ADE.
- Lightweight infrastructure appropriate for local execution.
- Separate from Nabla; never modify Nabla's codebase.

## 10. Scope

Out of scope: demo video, presentation materials, full OAuth, production account management, billing, additional coding agents, automatic Git merge resolution, general-purpose orchestration, advanced autonomous dependency inference, unnecessary cloud infrastructure.

## 11. Definition of Done

- Claude Code and Codex execute real coding tasks through the application.
- Their sessions operate independently within the same project.
- The system distinguishes developers and their respective agents.
- Agent tasks and dependencies are visible and accessible.
- Both agents use GBrain to share and retrieve project knowledge.
- Agents exchange coordination messages.
- Changes affecting dependent tasks are communicated to relevant agents.
- An agent incorporates another agent's decision into its actual coding work.
- Coordination events and outcomes are visible in the dashboard.
- The integrated application is verified through real functional testing.

Stored messages or simulated activity are never proof of actual agent collaboration.
