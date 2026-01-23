/**
 * BehaviorExecutor - Executes behavior steps for agent simulators
 *
 * Handles all step types, variable storage, and event dispatch.
 *
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 * @see i-3bdo Phase 2: Behavior Execution Engine
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

import type {
  BehaviorStep,
  SimulatedBehavior,
  SimulatorContext,
  SimulatorServices,
  SimulatedEvent,
  StepResult,
  ToolResult,
  AgentRole,
  DoneStatus,
  AgentSimulator,
} from "./types.js";

/**
 * Configuration for the behavior executor
 */
export interface BehaviorExecutorConfig {
  /** Agent ID for logging and events */
  agentId: string;

  /** Services for tool calls */
  services: SimulatorServices;

  /** Function to spawn child simulators */
  spawnChild: (step: {
    role: AgentRole;
    behavior: SimulatedBehavior;
    config?: Record<string, unknown>;
  }) => Promise<AgentSimulator>;

  /** Function called when done() is executed */
  onDone: (
    status: DoneStatus,
    summary?: string,
    details?: Record<string, unknown>
  ) => Promise<void>;
}

/**
 * Execution state for the behavior executor
 */
export interface ExecutorState {
  /** Current step index */
  currentStepIndex: number;

  /** Current steps being executed */
  currentSteps: BehaviorStep[];

  /** Whether waiting for an event */
  waitingForEvent: string | null;

  /** Whether waiting for a condition */
  waitingForCondition:
    | ((ctx: SimulatorContext) => boolean | Promise<boolean>)
    | null;

  /** Pending event handlers to execute */
  pendingEventHandlers: Array<{
    eventType: string;
    steps: BehaviorStep[];
    event: SimulatedEvent;
  }>;
}

/**
 * BehaviorExecutor handles step execution for agent simulators
 */
export class BehaviorExecutor {
  private config: BehaviorExecutorConfig;
  private state: ExecutorState;
  private eventQueue: SimulatedEvent[] = [];

  constructor(config: BehaviorExecutorConfig, initialSteps: BehaviorStep[]) {
    this.config = config;
    this.state = {
      currentStepIndex: 0,
      currentSteps: [...initialSteps],
      waitingForEvent: null,
      waitingForCondition: null,
      pendingEventHandlers: [],
    };
  }

  /**
   * Get current execution state
   */
  getState(): ExecutorState {
    return { ...this.state };
  }

  /**
   * Check if there are pending steps
   */
  hasPendingSteps(): boolean {
    // Has pending event handlers
    if (this.state.pendingEventHandlers.length > 0) {
      return true;
    }

    // Waiting for something
    if (this.state.waitingForEvent || this.state.waitingForCondition) {
      // Check if the wait condition is now satisfied
      if (this.state.waitingForEvent) {
        const event = this.findEvent(this.state.waitingForEvent);
        if (event) return true;
      }
      return false;
    }

    // Has more steps
    return this.state.currentStepIndex < this.state.currentSteps.length;
  }

  /**
   * Inject an event into the executor's queue
   */
  injectEvent(event: SimulatedEvent): void {
    this.eventQueue.push(event);
  }

  /**
   * Process injected events and dispatch to onEvent handlers
   */
  dispatchEvents(
    behavior: SimulatedBehavior,
    context: SimulatorContext
  ): void {
    if (!behavior.onEvent) return;

    // Check each event in the queue
    const processedIndices: number[] = [];

    for (let i = 0; i < this.eventQueue.length; i++) {
      const event = this.eventQueue[i];
      const handler = behavior.onEvent[event.type];

      if (handler) {
        // Queue the handler for execution
        this.state.pendingEventHandlers.push({
          eventType: event.type,
          steps: [...handler],
          event,
        });
        processedIndices.push(i);

        // Add event to context
        context.events.push(event);
      }
    }

    // Remove processed events (in reverse order to maintain indices)
    for (let i = processedIndices.length - 1; i >= 0; i--) {
      this.eventQueue.splice(processedIndices[i], 1);
    }
  }

  /**
   * Execute one step and return the result
   */
  async executeStep(
    context: SimulatorContext,
    behavior: SimulatedBehavior
  ): Promise<StepResult> {
    // First, dispatch any pending events to handlers
    this.dispatchEvents(behavior, context);

    // Check if we're executing an event handler
    if (this.state.pendingEventHandlers.length > 0) {
      const handler = this.state.pendingEventHandlers[0];

      if (handler.steps.length === 0) {
        // Handler complete, remove it
        this.state.pendingEventHandlers.shift();
        return {
          status: "completed",
          step: { type: "log", message: `Event handler for ${handler.eventType} completed` },
        };
      }

      // Execute next step in handler
      const step = handler.steps.shift()!;
      return this.executeStepImpl(step, context, behavior);
    }

    // Check if waiting for event
    if (this.state.waitingForEvent) {
      const event = this.findEvent(this.state.waitingForEvent);
      if (event) {
        const waitedEvent = this.state.waitingForEvent;
        this.state.waitingForEvent = null;
        context.events.push(event);
        this.state.currentStepIndex++;
        context.stepCount++;
        return {
          status: "completed",
          step: { type: "wait_for_event", event: waitedEvent },
          result: event,
        };
      }
      return {
        status: "waiting",
        step: { type: "wait_for_event", event: this.state.waitingForEvent },
      };
    }

    // Check if waiting for condition
    if (this.state.waitingForCondition) {
      const met = await this.state.waitingForCondition(context);
      if (met) {
        const waitedCondition = this.state.waitingForCondition;
        this.state.waitingForCondition = null;
        this.state.currentStepIndex++;
        context.stepCount++;
        return {
          status: "completed",
          step: { type: "wait_for_condition", condition: waitedCondition },
        };
      }
      return {
        status: "waiting",
        step: {
          type: "wait_for_condition",
          condition: this.state.waitingForCondition,
        },
      };
    }

    // Check if we have more steps
    if (this.state.currentStepIndex >= this.state.currentSteps.length) {
      // Check for conditional behaviors
      for (const conditional of behavior.conditions || []) {
        const met = await conditional.condition(context);
        if (met) {
          this.state.currentSteps = [...conditional.behavior];
          this.state.currentStepIndex = 0;
          if (conditional.once) {
            const idx = behavior.conditions!.indexOf(conditional);
            behavior.conditions!.splice(idx, 1);
          }
          break;
        }
      }

      // Still no steps? We're done
      if (this.state.currentStepIndex >= this.state.currentSteps.length) {
        return {
          status: "done",
          step: { type: "log", message: "No more steps" },
        };
      }
    }

    // Check for failure injection
    if (
      behavior.failAfter !== undefined &&
      context.stepCount >= behavior.failAfter
    ) {
      const error =
        behavior.failWith instanceof Error
          ? behavior.failWith
          : new Error(
              typeof behavior.failWith === "string"
                ? behavior.failWith
                : "Simulated failure"
            );

      return {
        status: "failed",
        step: this.state.currentSteps[this.state.currentStepIndex],
        error,
      };
    }

    // Execute the current step
    const step = this.state.currentSteps[this.state.currentStepIndex];
    const result = await this.executeStepImpl(step, context, behavior);

    context.stepCount++;

    // Move to next step if not waiting
    if (result.status !== "waiting") {
      this.state.currentStepIndex++;
    }

    return result;
  }

  /**
   * Execute a single step implementation
   */
  private async executeStepImpl(
    step: BehaviorStep,
    context: SimulatorContext,
    _behavior: SimulatedBehavior
  ): Promise<StepResult> {
    switch (step.type) {
      case "log":
        console.log(`[${this.config.agentId}] ${step.message}`);
        return { status: "completed", step };

      case "call_tool": {
        const toolResult = await this.handleToolCall(
          step.tool,
          step.params,
          context
        );
        if (step.storeResult && toolResult.success) {
          context.variables.set(step.storeResult, toolResult.result);
        }
        return {
          status: toolResult.success ? "completed" : "failed",
          step,
          result: toolResult.result,
          error: toolResult.error ? new Error(toolResult.error) : undefined,
        };
      }

      case "write_file":
        this.writeFile(step.path, step.content, context.workspacePath);
        return { status: "completed", step };

      case "read_file": {
        const content = this.readFile(step.path, context.workspacePath);
        context.variables.set(step.into, content);
        return { status: "completed", step, result: content };
      }

      case "commit": {
        const hash = this.gitCommit(step.message, context.workspacePath);
        return { status: "completed", step, result: hash };
      }

      case "wait_for_event": {
        const existingEvent = this.findEvent(step.event);
        if (existingEvent) {
          context.events.push(existingEvent);
          return { status: "completed", step, result: existingEvent };
        }
        this.state.waitingForEvent = step.event;
        return { status: "waiting", step };
      }

      case "wait_for_condition": {
        const met = await step.condition(context);
        if (met) {
          return { status: "completed", step };
        }
        this.state.waitingForCondition = step.condition;
        return { status: "waiting", step };
      }

      case "sleep":
        await this.delay(step.ms);
        return { status: "completed", step };

      case "spawn_child": {
        try {
          const childSimulator = await this.config.spawnChild({
            role: step.role,
            behavior: step.behavior,
            config: step.config as Record<string, unknown>,
          });
          return {
            status: "spawned_child",
            step,
            childAgentId: childSimulator.agentId,
          };
        } catch (error) {
          // Spawn failed (e.g., capability denied)
          return {
            status: "failed",
            step,
            error: error instanceof Error ? error : new Error(String(error)),
          };
        }
      }

      case "done":
        await this.config.onDone(step.status, step.summary, step.details);
        return { status: "done", step };

      case "emit_signal":
        this.config.services.messageRouter.emitStatus({
          from: { agent_id: this.config.agentId },
          status_type: "checkpoint",
          summary: step.signal,
          details: step.payload,
        });
        return { status: "completed", step };

      case "conditional": {
        const conditionMet = await step.if(context);
        const branchSteps = conditionMet ? step.then : step.else || [];
        // Insert branch steps after current position
        this.state.currentSteps.splice(
          this.state.currentStepIndex + 1,
          0,
          ...branchSteps
        );
        return { status: "completed", step };
      }

      case "assert": {
        const assertMet = await step.condition(context);
        if (!assertMet) {
          throw new Error(step.message || "Assertion failed");
        }
        return { status: "completed", step };
      }

      default:
        return {
          status: "failed",
          step,
          error: new Error(
            `Unknown step type: ${(step as BehaviorStep).type}`
          ),
        };
    }
  }

  /**
   * Handle a tool call
   */
  private async handleToolCall(
    tool: string,
    params: Record<string, unknown>,
    context: SimulatorContext
  ): Promise<ToolResult> {
    const services = this.config.services;
    const agentId = this.config.agentId;

    try {
      switch (tool) {
        case "emit_status":
          services.messageRouter.emitStatus({
            from: { agent_id: agentId },
            status_type: (params.status_type as string) || "checkpoint",
            summary: params.summary as string,
            details: params.details as Record<string, unknown>,
          });
          return { success: true };

        case "send_message": {
          const msg = await services.messageRouter.send({
            from: { agent_id: agentId },
            to: params.to as {
              agent_id?: string;
              task_id?: string;
              topic?: string;
            },
            content: params.content as string,
            priority: params.priority as "low" | "normal" | "high" | "urgent",
          });
          return { success: true, result: msg };
        }

        case "check_messages": {
          const messages = services.messageRouter.getMessages(agentId);
          return { success: true, result: messages };
        }

        case "create_task": {
          const task = services.taskManager.create({
            description: params.description as string,
            created_by: agentId,
            parent_task: params.parent_task as string,
          });
          return { success: true, result: task };
        }

        case "get_task": {
          const foundTask = services.taskManager.get(params.task_id as string);
          return { success: true, result: foundTask };
        }

        case "bash": {
          const output = execSync(params.command as string, {
            cwd: context.workspacePath,
            encoding: "utf8",
            stdio: "pipe",
          });
          return { success: true, result: output };
        }

        default:
          return {
            success: false,
            error: `Unknown tool: ${tool}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Find and remove an event from the queue
   */
  private findEvent(eventType: string): SimulatedEvent | undefined {
    const idx = this.eventQueue.findIndex((e) => e.type === eventType);
    if (idx >= 0) {
      return this.eventQueue.splice(idx, 1)[0];
    }
    return undefined;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // File and Git Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private writeFile(
    filePath: string,
    content: string,
    workspacePath: string
  ): void {
    const fullPath = path.join(workspacePath, filePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, content);
  }

  private readFile(filePath: string, workspacePath: string): string {
    const fullPath = path.join(workspacePath, filePath);
    return fs.readFileSync(fullPath, "utf8");
  }

  private gitCommit(message: string, workspacePath: string): string {
    this.git("add .", workspacePath);
    this.git(`commit -m "${message.replace(/"/g, '\\"')}"`, workspacePath);
    return this.git("rev-parse HEAD", workspacePath);
  }

  private git(args: string, cwd: string): string {
    try {
      return execSync(`git ${args}`, {
        cwd,
        stdio: "pipe",
        encoding: "utf8",
      }).trim();
    } catch (error: unknown) {
      const execError = error as { stderr?: string; message?: string };
      throw new Error(
        `Git command failed: git ${args}\n${execError.stderr || execError.message}`
      );
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Create a new behavior executor
 */
export function createBehaviorExecutor(
  config: BehaviorExecutorConfig,
  initialSteps: BehaviorStep[]
): BehaviorExecutor {
  return new BehaviorExecutor(config, initialSteps);
}
