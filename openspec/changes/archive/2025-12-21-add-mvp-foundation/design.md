## Context

Building the MVP for macro-agent, a multi-agent orchestration system. The system must support:
- Event-sourced architecture for auditability and replay
- Hierarchical agent spawning with parent-child relationships
- Inter-agent messaging with subscription-based routing
- User interaction via CLI with real-time updates
- Integration with Claude Code via ACP wrapper

Key constraints:
- Local-first (runs on developer machine)
- Must persist state across sessions
- Must support parallel agent execution
- Must provide real-time visibility into agent activity

## Goals / Non-Goals

**Goals:**
- Establish foundational event-sourced architecture
- Enable head manager to spawn and coordinate child agents
- Provide CLI for user interaction with real-time feedback
- Support parallel implementation of core managers

**Non-Goals (Phase 2):**
- Fork mechanics and mount/remount abstraction
- Blackboard system for cross-agent state
- Resource management (limits, throttling)
- Advanced context merging/summarization
- Semantic search in index

## Decisions

### Decision 1: TinyBase for Event Store

**Choice:** Use TinyBase for the event log and materialized views.

**Rationale:**
- Built-in persistence to SQLite
- Reactive updates (views auto-update on changes)
- Lightweight, no external database needed
- Good fit for local-first architecture

**Alternatives considered:**
- SQLite directly: More control but no reactive updates
- LevelDB: Fast but less query flexibility
- In-memory only: Simpler but no persistence

### Decision 2: Event Sourcing with Materialized Views

**Choice:** Append-only event log as source of truth, with computed views for agents/tasks/messages.

**Rationale:**
- Full audit trail for debugging
- State can be rebuilt from events
- Natural fit for multi-agent coordination
- Enables time-travel debugging (future)

**Trade-offs:**
- More complex than direct state mutation
- Views must be kept in sync
- Storage grows over time (archival needed later)

### Decision 3: Subscription-Based Message Routing

**Choice:** Agents subscribe to channels (agent, task, lineage, subtree, topic) and receive matching events.

**Rationale:**
- Flexible routing without hard-coded relationships
- Parent auto-subscribes to subtree for visibility
- Child auto-subscribes to lineage for upward visibility
- Explicit topics for cross-branch communication

**Alternatives considered:**
- Direct addressing only: Simpler but less flexible
- Central message broker: Overkill for local system

### Decision 4: MCP for Agent Tools

**Choice:** Expose multi-agent capabilities via MCP (Model Context Protocol) tools.

**Rationale:**
- Standard protocol for Claude Code integration
- Tools are self-documenting
- Clean separation between orchestration and agent execution

### Decision 5: REST + WebSocket API

**Choice:** REST for commands, WebSocket for real-time updates.

**Rationale:**
- REST for simple request/response (send message, query state)
- WebSocket for streaming updates (agent status, new messages)
- CLI subscribes via WebSocket for live feedback

### Decision 6: Parallel Manager Implementation

**Choice:** Agent Manager, Task Manager, and Message Router can be implemented in parallel after Event Store.

**Rationale:**
- Each manager only depends on Event Store
- Clear interface boundaries (emit events, query views)
- Enables faster implementation with multiple workers

**Dependencies:**
```
Event Store ─┬─► Agent Manager ─┐
             ├─► Task Manager  ─┼─► MCP Tools ─► CLI/API
             └─► Message Router─┘
```

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| TinyBase performance at scale | MVP targets small scale; can swap storage later |
| Event log grows unbounded | Add archival in Phase 2 |
| View sync bugs | Comprehensive tests for event → view projection |
| ACP integration complexity | Define clean wrapper interface; mock for testing |

## Migration Plan

Not applicable - greenfield implementation.

## Open Questions

1. **ACP Wrapper Details:** Exact protocol for Claude Code integration needs separate design doc
2. **System Prompt Template:** Final template content to be refined during implementation
3. **Error Handling Strategy:** How errors propagate across agent boundaries (separate doc)
