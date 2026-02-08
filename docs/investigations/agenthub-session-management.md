# AgentHub Session Management Investigation

## Overview

Investigation into [AgentHub](https://github.com/jamesrochabrun/AgentHub) session management strategies and their applicability to macro-agent.

## What AgentHub Is

AgentHub is a **macOS-native monitoring dashboard** (Swift/SwiftUI) for Claude Code CLI sessions. It does not run agents itself — it **observes and tracks** sessions spawned by the Claude CLI by reading their filesystem artifacts (`~/.claude/projects/{path}/{sessionId}.jsonl`).

## AgentHub's Key Session Strategies

### 1. File-System Session Discovery
- Scans `~/.claude/projects/` directory for JSONL session files
- Parses `history.jsonl` for session metadata (timestamps, project paths, session IDs)
- File modification timestamps determine "active" status (modified within 60s)
- Key file: `CLISessionMonitorService.swift`

### 2. Real-Time Monitoring via File Watchers
- `DispatchSource`-based file watchers on session JSONL files
- **Incremental offset-based reads** — tracks file position, only parses new lines
- 1.5-second polling fallback for missed events
- Stale watcher recovery: re-reads if file grew without event for 5+ seconds
- Key file: `SessionFileWatcher.swift`

### 3. Session State Machine (5 states)
```
thinking → executingTool → waitingForUser
                         → awaitingApproval (timeout-based)
                         → idle (no recent activity)
```
State transitions derived from JSONL entry parsing. Timeout heuristics distinguish `awaitingApproval` from normal tool execution.
- Key file: `SessionMonitorState.swift`

### 4. Persistent Metadata (SQLite via GRDB)

| Table | Purpose |
|-------|---------|
| `session_metadata` | User-assigned custom session names (PK: sessionId) |
| `session_repo_mapping` | Prevents session mis-assignment across repos (PK: sessionId) |

The `session_repo_mapping` table ensures worktree path reuse doesn't cause incorrect session attribution.
- Key file: `SessionMetadataStore.swift`

### 5. Pending Session Lifecycle
1. `PendingHubSession` created with UUID + worktree info + initial prompt
2. Filesystem watcher polls for new `.jsonl` files
3. New session file detected → pending session converted to real monitored session
4. Terminal view transferred from pending UUID to real session ID

### 6. Provider Abstraction
Protocols (`SessionMonitorServiceProtocol`, `SessionFileWatcherProtocol`, `SessionSearchServiceProtocol`) with concrete implementations for both Claude and Codex backends.

### 7. Cost and Token Tracking
- Parses token counts from JSONL entries (input, output, cache read/write)
- `CostCalculator` with model-specific pricing (Opus, Sonnet, Haiku)
- `GlobalStatsService` aggregates across all sessions

### 8. Cross-Session Search
- In-memory index of `SessionIndexEntry` objects built via parallel `TaskGroup`
- Searches: slug, project path, git branch, summaries, first message
- File modification timestamps for index invalidation

## macro-agent's Current Session Architecture

### Layer 1: ACP Protocol Sessions
- `MacroAgent.newSession()` spawns head manager, creates `SessionMapping`
- `MacroAgent.loadSession()` finds/resumes agents by `session_id`
- Per-WebSocket-connection isolation (each connection gets own MacroAgent + SessionMapper)
- Key file: `src/acp/macro-agent.ts`

### Layer 2: SessionMapper (In-Memory)
- `Map<ACPSessionId, SessionMapping>` — purely in-memory
- Mount/unmount: dynamically re-target which agent a session controls
- Processing tracking: `isProcessing` boolean for health monitoring
- **Not persisted** — lost on process restart
- Key file: `src/acp/session-mapper.ts`

### Layer 3: AgentManager Active Sessions (In-Memory)
- `Map<AgentId, ActiveSession>` tracking subprocess handles
- Bridges macro-agent to `acp-factory` process management
- Session IDs generated at spawn: `session_${nanoid(12)}`
- Resume via `handle.loadSession(agent.session_id, cwd)`
- Key file: `src/agent/agent-manager.ts`

### Layer 4: EventStore (Persistent)
- Append-only SQLite event log with materialized views
- Agent records contain `session_id` — the link for session resumption
- Tracks agent lifecycle events but **no session-specific events**
- Key file: `src/store/event-store.ts`

## Gap Analysis

| Concern | AgentHub | macro-agent | Gap |
|---------|----------|-------------|-----|
| Session state model | 5-state enum | `isProcessing` boolean | **Major** — no granular state |
| Session persistence | SQLite metadata + repo mappings | In-memory SessionMapper only | **Major** — lost on restart |
| Session lifecycle events | Derived from JSONL parsing | None | **Major** — no audit trail |
| Session metrics | Token counts, costs, duration | None | **Moderate** — no observability |
| Session timeout/GC | 60s file-mod heuristic | None | **Moderate** — stale sessions leak |
| Mount state recovery | N/A (different model) | Not persisted | **Moderate** — mount lost on restart |
| Real-time monitoring | File watchers + incremental reads | EventStore events (no session stream) | **Minor** — different architecture |

## Recommended Adoptions

### High Priority

#### 1. Session State Machine
Replace `isProcessing: boolean` with a proper state enum:
```typescript
type SessionState =
  | 'idle'
  | 'prompting'
  | 'executing_tool'
  | 'waiting_for_input'
  | 'injecting'
  | 'suspended';
```
This directly mirrors AgentHub's 5-state model adapted for macro-agent's context.

#### 2. Persist Session Lifecycle Events
Add session events to the EventStore:
- `session_created` — ACP session established, mapped to agent
- `session_mounted` — session re-targeted to different agent
- `session_unmounted` — session returned to head manager
- `session_closed` — session explicitly terminated

This enables:
- Recovery of SessionMapper state after restart
- Full session audit trail
- Session analytics

#### 3. Session Metrics in EventStore
Track per-session:
- Prompt count
- Total tokens (input/output/cache)
- Session duration (created → last activity → closed)
- Error count

### Medium Priority

#### 4. Session Timeout / Garbage Collection
Add configurable session expiry (e.g., `MACRO_SESSION_TIMEOUT_MS`):
- Periodic sweep of `SessionMapper` entries
- Use `lastProcessingChangeAt` + timeout threshold
- Emit `session_expired` event on cleanup

#### 5. Persist Mount State
When a session is mounted to a non-head-manager via `SessionMapper.mount()`, emit a `session_mounted` event. On restart, rebuild mount state from EventStore.

### Not Recommended

| Strategy | Reason |
|----------|--------|
| File-based session discovery | macro-agent owns session creation programmatically |
| Provider abstraction protocols | macro-agent is purpose-built for Claude Code |
| DispatchSource file watchers | Platform-specific; EventStore is the right abstraction |
| Pending session handoff | macro-agent handles creation synchronously |

## Implementation Notes

### Session Events Schema
```typescript
interface SessionEvent {
  type: 'session_created' | 'session_mounted' | 'session_unmounted' | 'session_closed' | 'session_expired';
  session_id: SessionId;
  agent_id: AgentId;
  // For mount/unmount:
  target_agent_id?: AgentId;
  previous_agent_id?: AgentId;
  timestamp: Timestamp;
}
```

### Recovery on Restart
1. Load all agents from EventStore with `state === 'running'`
2. Replay session events to rebuild `SessionMapper` state
3. For each mapped session, check if agent subprocess is alive
4. If not alive and state is 'running', mark as requiring resume

### Integration Points
- `SessionMapper.set/mount/unmount/delete` → emit corresponding EventStore events
- `EventStore.reload()` → rebuild SessionMapper from events (new method)
- `AgentManager.resume()` → also restore session mapping
