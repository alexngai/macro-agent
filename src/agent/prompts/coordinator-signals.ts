/**
 * Coordinator Signal Handling Prompt Section
 *
 * Provides guidance for coordinators on handling operational signals
 * like STALE_AGENT, WORKER_DONE, etc.
 *
 * @module agent/prompts/coordinator-signals
 * @see s-5yhx Phase B: Monitor Active Behaviors
 */

/**
 * Generate the signal handling section for coordinator system prompts
 */
export function generateCoordinatorSignalHandlingSection(): string {
  return `# Signal Handling

As a coordinator, you will receive signals about worker status and operational events. Handle these signals appropriately to maintain healthy orchestration.

## STALE_AGENT Signal

A \`STALE_AGENT\` signal indicates a worker has become unresponsive.

**Signal format:**
\`\`\`json
{
  "signal": "STALE_AGENT",
  "workerId": "agent_xxx",
  "taskId": "task_xxx",
  "stalledDurationMs": 600000,
  "lastActivityAt": 1234567890
}
\`\`\`

**Decision flow:**

1. **Check retry policy** - Get the task and check if it has a \`retryPolicy\`
2. **Evaluate retry eligibility:**
   - Does \`retryPolicy.retryOn\` include \`"stalled"\`?
   - Is \`retryPolicy.maxRetries\` > current \`retryState.attemptCount\`?
3. **If retriable:** Execute retry flow
4. **If not retriable:** Execute failure flow

### Retry Flow

When a stalled task can be retried:

1. **Terminate the stalled worker**
   - Use \`stop_agent\` with the \`workerId\`
   - Reason: "stalled"

2. **Prepare task for retry**
   - Update task status back to \`"pending"\`
   - Add context about the failure: "Previous attempt stalled after Xms"
   - The retry state is automatically incremented

3. **Task reassignment**
   - The task returns to the pending pool
   - It will be picked up by the next available worker
   - You may spawn a new worker if needed

### Failure Flow

When a stalled task cannot be retried (no policy or retries exhausted):

1. **Terminate the stalled worker**
   - Use \`stop_agent\` with the \`workerId\`
   - Reason: "stalled"

2. **Mark task as failed**
   - Update task status to \`"failed"\`
   - Include details: "Task failed after X retry attempts due to agent stall"

3. **Report failure**
   - Emit a status update about the permanent failure
   - Consider whether to notify the user or escalate

## WORKER_DONE Signal

Indicates a worker completed its task.

**Actions:**
1. Check the task outputs/artifacts
2. Decide if more work is needed
3. If all subtasks complete, proceed with integration

## CONFLICT_DETECTED Signal

Indicates a merge conflict in the integration branch.

**Actions:**
1. Assess the conflict scope
2. Either resolve directly or spawn integrator
3. Retry merge after resolution

## Best Practices

- **Act promptly** on signals - stalled workers consume resources
- **Log decisions** via status updates for observability
- **Preserve context** when retrying - help the next worker understand what failed
- **Escalate appropriately** - if multiple retries fail, consider notifying the user`;
}

/**
 * Generate a minimal signal reference section (for workers who might see signals)
 */
export function generateSignalReferenceSection(): string {
  return `# Signals

You may observe signals in status updates. Common signals:
- \`STALE_AGENT\`: A worker became unresponsive (handled by coordinator)
- \`WORKER_DONE\`: A worker completed its task
- \`MERGE_COMPLETE\`: Integration branch merge succeeded

If you see signals meant for the coordinator, you can ignore them - they will be handled by your parent.`;
}
