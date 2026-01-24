/**
 * AgentSimulator - Simulates agent behavior without Claude API calls
 *
 * Registers agents in EventStore and executes behavior scripts against real services.
 *
 * @see s-1zcx Multi-Agent Orchestration Testing Strategy
 */

import { nanoid } from "nanoid";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

import type { EventStore } from "../../../src/store/event-store.js";
import type { MessageRouter } from "../../../src/router/message-router.js";
import type {
  AgentSimulator,
  AgentRole,
  SimulatedBehavior,
  SimulatorContext,
  SimulatorServices,
  SimulatorConfig,
  SimulatedEvent,
  BehaviorStep,
  StepResult,
  ToolResult,
  WorkspaceState,
  GitState,
  ExecutionLogEntry,
  DoneStatus,
} from "./types.js";
import { BehaviorExecutor } from "./behavior-executor.js";
import { AGENT_CAPABILITIES } from "../../../src/roles/capabilities.js";
import { DefaultRoleRegistry } from "../../../src/roles/registry.js";
import type { Capability } from "../../../src/roles/types.js";

/**
 * Create a new agent simulator
 */
export function createAgentSimulator(
  config: SimulatorConfig,
  services: SimulatorServices
): AgentSimulator {
  return new DefaultAgentSimulator(config, services);
}

/**
 * Default implementation of AgentSimulator
 */
class DefaultAgentSimulator implements AgentSimulator {
  readonly agentId: string;
  readonly role: AgentRole;
  readonly sessionId: string;

  behavior: SimulatedBehavior;

  private config: SimulatorConfig;
  private services: SimulatorServices;
  private context: SimulatorContext | null = null;
  private running = false;
  private paused = false;

  // Execution state
  private currentStepIndex = 0;
  private currentSteps: BehaviorStep[] = [];
  private executionLog: ExecutionLogEntry[] = [];
  private eventQueue: SimulatedEvent[] = [];

  // Waiting state
  private waitingForEvent: string | null = null;
  private waitingForCondition: ((ctx: SimulatorContext) => boolean | Promise<boolean>) | null = null;

  // Behavior executor (Phase 2)
  private executor: BehaviorExecutor | null = null;

  constructor(config: SimulatorConfig, services: SimulatorServices) {
    this.config = config;
    this.services = services;
    this.behavior = config.behavior;

    this.agentId = config.agentId || `sim-${nanoid(8)}`;
    this.sessionId = `session-${this.agentId}`;
    this.role = config.role;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  async start(
    partialContext: Omit<
      SimulatorContext,
      "variables" | "events" | "children" | "stuckAgents" | "stepCount" | "startedAt"
    >
  ): Promise<void> {
    if (this.running) {
      throw new Error(`Simulator ${this.agentId} is already running`);
    }

    // Build full context
    this.context = {
      ...partialContext,
      variables: new Map(),
      events: [],
      children: [],
      stuckAgents: [],
      stepCount: 0,
      startedAt: Date.now(),
    };

    // Register agent in EventStore via spawn event
    this.services.eventStore.emit({
      type: "spawn",
      source: { agent_id: this.context.parentId || "system" },
      payload: {
        agent_id: this.agentId,
        session_id: this.sessionId,
        task: `Simulated ${this.role}`,
        task_id: this.context.taskId,
        parent: this.context.parentId || null,
        cwd: this.context.workspacePath,
        role: this.role,
        config: {},
      },
    });

    // Emit started status
    this.services.eventStore.emit({
      type: "status",
      source: { agent_id: this.agentId },
      payload: {
        status_type: "started",
        summary: `Simulated ${this.role} started`,
      },
    });

    this.running = true;

    // Initialize with onStart steps
    this.currentSteps = [...this.behavior.onStart];
    this.currentStepIndex = 0;

    // Initialize behavior executor
    this.executor = new BehaviorExecutor(
      {
        agentId: this.agentId,
        services: this.services,
        spawnChild: this.spawnChild.bind(this),
        onDone: this.handleDone.bind(this),
      },
      this.behavior.onStart
    );
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    // Emit terminate event
    this.services.eventStore.emit({
      type: "terminate",
      source: { agent_id: this.agentId },
      payload: {
        agent_id: this.agentId,
        reason: "stopped",
      },
    });

    this.running = false;
    this.context = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Execution Control
  // ─────────────────────────────────────────────────────────────────────────

  async stepOnce(): Promise<StepResult> {
    if (!this.running || !this.context) {
      return {
        status: "failed",
        step: { type: "log", message: "Not running" },
        error: new Error("Simulator not running"),
      };
    }

    if (this.paused) {
      return {
        status: "waiting",
        step: { type: "log", message: "Paused" },
      };
    }

    // Check if waiting for event
    if (this.waitingForEvent) {
      const event = this.findEvent(this.waitingForEvent);
      if (event) {
        const waitedEvent = this.waitingForEvent;
        this.waitingForEvent = null;
        this.context.events.push(event);
        this.currentStepIndex++;
        this.context.stepCount++;
        return {
          status: "completed",
          step: { type: "wait_for_event", event: waitedEvent },
          result: event,
        };
      }
      return {
        status: "waiting",
        step: { type: "wait_for_event", event: this.waitingForEvent },
      };
    }

    // Check if waiting for condition
    if (this.waitingForCondition) {
      const met = await this.waitingForCondition(this.context);
      if (met) {
        const waitedCondition = this.waitingForCondition;
        this.waitingForCondition = null;
        this.currentStepIndex++;
        this.context.stepCount++;
        return {
          status: "completed",
          step: { type: "wait_for_condition", condition: waitedCondition },
        };
      } else {
        return {
          status: "waiting",
          step: { type: "wait_for_condition", condition: this.waitingForCondition },
        };
      }
    }

    // Check if we have more steps
    if (this.currentStepIndex >= this.currentSteps.length) {
      // Check for conditional behaviors
      for (const conditional of this.behavior.conditions || []) {
        const met = await conditional.condition(this.context);
        if (met) {
          this.currentSteps = [...conditional.behavior];
          this.currentStepIndex = 0;
          if (conditional.once) {
            // Remove from conditions
            const idx = this.behavior.conditions!.indexOf(conditional);
            this.behavior.conditions!.splice(idx, 1);
          }
          break;
        }
      }

      // Still no steps? We're done
      if (this.currentStepIndex >= this.currentSteps.length) {
        return {
          status: "done",
          step: { type: "log", message: "No more steps" },
        };
      }
    }

    // Check for failure injection
    if (
      this.behavior.failAfter !== undefined &&
      this.context.stepCount >= this.behavior.failAfter
    ) {
      const error =
        this.behavior.failWith instanceof Error
          ? this.behavior.failWith
          : new Error(this.behavior.failWith || "Simulated failure");

      return {
        status: "failed",
        step: this.currentSteps[this.currentStepIndex],
        error,
      };
    }

    // Execute the current step
    const step = this.currentSteps[this.currentStepIndex];
    const startTime = Date.now();

    try {
      const result = await this.executeStep(step);
      const duration = Date.now() - startTime;

      // Log execution
      this.executionLog.push({
        timestamp: Date.now(),
        stepIndex: this.currentStepIndex,
        step,
        result,
        duration,
      });

      this.context.stepCount++;

      // Move to next step if not waiting
      if (result.status !== "waiting") {
        this.currentStepIndex++;
      }

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      const result: StepResult = {
        status: "failed",
        step,
        error: error instanceof Error ? error : new Error(String(error)),
      };

      this.executionLog.push({
        timestamp: Date.now(),
        stepIndex: this.currentStepIndex,
        step,
        result,
        duration,
      });

      return result;
    }
  }

  hasPendingSteps(): boolean {
    if (!this.running || !this.context) return false;
    if (this.paused) return false;

    // Waiting for something
    if (this.waitingForEvent || this.waitingForCondition) {
      // Check if the wait condition is now satisfied (peek, don't consume)
      if (this.waitingForEvent) {
        const hasEvent = this.peekEvent(this.waitingForEvent);
        if (hasEvent) return true; // Can proceed
      }
      return false; // Still waiting
    }

    // Has more steps
    if (this.currentStepIndex < this.currentSteps.length) {
      return true;
    }

    // Check conditional behaviors
    return false;
  }

  pauseExecution(): void {
    this.paused = true;
  }

  resumeExecution(): void {
    this.paused = false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step Execution
  // ─────────────────────────────────────────────────────────────────────────

  private async executeStep(step: BehaviorStep): Promise<StepResult> {
    switch (step.type) {
      case "log":
        console.log(`[${this.agentId}] ${step.message}`);
        return { status: "completed", step };

      case "call_tool":
        const toolResult = await this.handleToolCall(step.tool, step.params);
        if (step.storeResult && toolResult.success) {
          this.context!.variables.set(step.storeResult, toolResult.result);
        }
        return {
          status: toolResult.success ? "completed" : "failed",
          step,
          result: toolResult.result,
          error: toolResult.error ? new Error(toolResult.error) : undefined,
        };

      case "write_file":
        this.writeFile(step.path, step.content);
        return { status: "completed", step };

      case "read_file":
        const content = this.readFile(step.path);
        this.context!.variables.set(step.into, content);
        return { status: "completed", step, result: content };

      case "commit":
        const hash = this.gitCommit(step.message);
        return { status: "completed", step, result: hash };

      case "wait_for_event":
        const existingEvent = this.findEvent(step.event);
        if (existingEvent) {
          this.context!.events.push(existingEvent);
          return { status: "completed", step, result: existingEvent };
        }
        this.waitingForEvent = step.event;
        return { status: "waiting", step };

      case "wait_for_condition":
        const met = await step.condition(this.context!);
        if (met) {
          return { status: "completed", step };
        }
        this.waitingForCondition = step.condition;
        return { status: "waiting", step };

      case "sleep":
        await this.delay(step.ms);
        return { status: "completed", step };

      case "spawn_child":
        try {
          const childSimulator = await this.spawnChild(step);
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

      case "done":
        await this.handleDone(step.status, step.summary, step.details);
        return { status: "done", step };

      case "emit_signal":
        this.services.messageRouter.emitStatus({
          from: { agent_id: this.agentId },
          status_type: "checkpoint",
          summary: step.signal,
          details: step.payload,
        });
        return { status: "completed", step };

      case "conditional":
        const conditionMet = await step.if(this.context!);
        const branchSteps = conditionMet ? step.then : step.else || [];
        // Insert branch steps after current position
        this.currentSteps.splice(
          this.currentStepIndex + 1,
          0,
          ...branchSteps
        );
        return { status: "completed", step };

      case "assert":
        const assertMet = await step.condition(this.context!);
        if (!assertMet) {
          throw new Error(step.message || "Assertion failed");
        }
        return { status: "completed", step };

      default:
        return {
          status: "failed",
          step,
          error: new Error(`Unknown step type: ${(step as BehaviorStep).type}`),
        };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tool Execution
  // ─────────────────────────────────────────────────────────────────────────

  async handleToolCall(tool: string, params: unknown): Promise<ToolResult> {
    const p = params as Record<string, unknown>;

    try {
      switch (tool) {
        case "emit_status":
          this.services.messageRouter.emitStatus({
            from: { agent_id: this.agentId },
            status_type: (p.status_type as string) || "checkpoint",
            summary: p.summary as string,
            details: p.details as Record<string, unknown>,
          });
          return { success: true };

        case "send_message":
          const msg = await this.services.messageRouter.send({
            from: { agent_id: this.agentId },
            to: p.to as { agent_id?: string; task_id?: string; topic?: string },
            content: p.content as string,
            priority: p.priority as "low" | "normal" | "high" | "urgent",
          });
          return { success: true, result: msg };

        case "check_messages":
          const messages = this.services.messageRouter.getMessages(this.agentId);
          return { success: true, result: messages };

        case "create_task":
          const task = this.services.taskManager.create({
            description: p.description as string,
            created_by: this.agentId,
            parent_task: p.parent_task as string,
          });
          return { success: true, result: task };

        case "get_task":
          const foundTask = this.services.taskManager.get(p.task_id as string);
          return { success: true, result: foundTask };

        case "bash":
          // Execute bash command in workspace
          const output = execSync(p.command as string, {
            cwd: this.context!.workspacePath,
            encoding: "utf8",
            stdio: "pipe",
          });
          return { success: true, result: output };

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

  // ─────────────────────────────────────────────────────────────────────────
  // Event Injection
  // ─────────────────────────────────────────────────────────────────────────

  injectEvent(event: SimulatedEvent): void {
    this.eventQueue.push(event);
    // Also inject into executor for onEvent handler dispatch
    if (this.executor) {
      this.executor.injectEvent(event);
    }
  }

  private findEvent(eventType: string): SimulatedEvent | undefined {
    const idx = this.eventQueue.findIndex((e) => e.type === eventType);
    if (idx >= 0) {
      return this.eventQueue.splice(idx, 1)[0];
    }
    return undefined;
  }

  private peekEvent(eventType: string): boolean {
    return this.eventQueue.some((e) => e.type === eventType);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // State Access
  // ─────────────────────────────────────────────────────────────────────────

  getWorkspaceState(): WorkspaceState {
    const workspacePath = this.context?.workspacePath || this.config.repoPath;
    const branch = this.git("rev-parse --abbrev-ref HEAD", workspacePath);
    const status = this.git("status --porcelain", workspacePath);
    const files = fs.readdirSync(workspacePath);

    return {
      path: workspacePath,
      branch,
      hasUncommittedChanges: status.length > 0,
      files,
    };
  }

  getGitState(): GitState {
    const workspacePath = this.context?.workspacePath || this.config.repoPath;
    const currentBranch = this.git("rev-parse --abbrev-ref HEAD", workspacePath);
    const branchesOutput = this.git("branch --list", workspacePath);
    const branches = branchesOutput
      .split("\n")
      .map((b) => b.trim().replace(/^\* /, ""))
      .filter(Boolean);
    const status = this.git("status --porcelain", workspacePath);
    const uncommittedFiles = status
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3));

    let lastCommit: { hash: string; message: string } | undefined;
    try {
      const hash = this.git("rev-parse HEAD", workspacePath);
      const message = this.git("log -1 --pretty=%s", workspacePath);
      lastCommit = { hash, message };
    } catch {
      // No commits yet
    }

    return {
      currentBranch,
      branches,
      uncommittedFiles,
      lastCommit,
    };
  }

  getExecutionLog(): ExecutionLogEntry[] {
    return [...this.executionLog];
  }

  getContext(): SimulatorContext {
    if (!this.context) {
      throw new Error("Simulator not started");
    }
    return this.context;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private writeFile(filePath: string, content: string): void {
    const fullPath = path.join(this.context!.workspacePath, filePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, content);
  }

  private readFile(filePath: string): string {
    const fullPath = path.join(this.context!.workspacePath, filePath);
    return fs.readFileSync(fullPath, "utf8");
  }

  private gitCommit(message: string): string {
    const cwd = this.context!.workspacePath;
    this.git("add .", cwd);
    this.git(`commit -m "${message.replace(/"/g, '\\"')}"`, cwd);
    return this.git("rev-parse HEAD", cwd);
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

  private async spawnChild(step: {
    role: AgentRole;
    behavior: SimulatedBehavior;
    config?: Partial<SimulatorConfig>;
  }): Promise<AgentSimulator> {
    // Check spawn capability
    const roleRegistry = this.services.roleRegistry ?? new DefaultRoleRegistry();
    const parentRole = this.role ?? "worker";
    const childRole = step.role;
    const requiredCapability = this.getSpawnCapability(childRole);

    if (!roleRegistry.hasCapability(parentRole, requiredCapability)) {
      throw new Error(
        `Parent agent with role '${parentRole}' does not have capability to spawn '${childRole}' agents. ` +
          `Required capability: ${requiredCapability}`
      );
    }

    const childConfig: SimulatorConfig = {
      role: step.role,
      behavior: step.behavior,
      repoPath: this.context!.workspacePath,
      parentId: this.agentId,
      streamId: this.context!.streamId,
      ...step.config,
    };

    const child = createAgentSimulator(childConfig, this.services);
    await child.start({
      agentId: child.agentId,
      role: step.role,
      parentId: this.agentId,
      workspacePath: childConfig.cwd || this.context!.workspacePath,
      streamId: this.context!.streamId,
      services: this.services,
    });

    this.context!.children.push(child);
    return child;
  }

  /**
   * Map a child role name to the required spawn capability
   * Handles subroles like "worker.resolver" by checking base role
   */
  private getSpawnCapability(childRole: string): Capability {
    // Extract base role (e.g., "worker.resolver" -> "worker")
    const baseRole = childRole.split(".")[0];

    switch (baseRole) {
      case "worker":
        return AGENT_CAPABILITIES.SPAWN_WORKER;
      case "integrator":
        return AGENT_CAPABILITIES.SPAWN_INTEGRATOR;
      case "monitor":
        return AGENT_CAPABILITIES.SPAWN_MONITOR;
      case "coordinator":
        return AGENT_CAPABILITIES.SPAWN_CUSTOM;
      default:
        return AGENT_CAPABILITIES.SPAWN_CUSTOM;
    }
  }

  private async handleDone(
    status: DoneStatus,
    summary?: string,
    details?: Record<string, unknown>
  ): Promise<void> {
    // Emit status
    this.services.messageRouter.emitStatus({
      from: { agent_id: this.agentId },
      status_type: status === "completed" ? "completed" : "failed",
      summary: summary || `Agent ${status}`,
      details,
    });

    // Emit terminate event
    this.services.eventStore.emit({
      type: "terminate",
      source: { agent_id: this.agentId },
      payload: {
        agent_id: this.agentId,
        reason: status,
      },
    });

    this.running = false;
  }
}
