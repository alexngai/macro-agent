#!/usr/bin/env node
/**
 * Multi-Agent CLI
 *
 * Command-line interface for inspecting and managing the multi-agent system.
 * For running the server, use `multiagent` instead.
 *
 * Usage:
 *   multiagent-cli <command> [options]
 */

import { Command } from "commander";
import chalk from "chalk";
import { createEventStore } from "../store/event-store.js";
import { createAgentManager } from "../agent/agent-manager.js";
import { createTaskManager } from "../task/task-manager.js";
import { createMessageRouter } from "../router/message-router.js";
import { createAPIServer } from "../api/server.js";
import { loadProjectConfig } from "../config/project-config.js";
import { loadTeam, TeamRuntime } from "../teams/index.js";
import { createTaskBackend, loadTaskConfigFromEnv } from "../task/backend/index.js";
import type { Agent, Task } from "../store/types/index.js";

// ─────────────────────────────────────────────────────────────────
// Formatting Helpers
// ─────────────────────────────────────────────────────────────────

function formatState(state: string): string {
  switch (state) {
    case "running":
      return chalk.green("running");
    case "stopped":
      return chalk.gray("stopped");
    case "spawning":
      return chalk.yellow("spawning");
    default:
      return state;
  }
}

function formatStatus(status: string): string {
  switch (status) {
    case "pending":
      return chalk.gray("pending");
    case "assigned":
      return chalk.blue("assigned");
    case "in_progress":
      return chalk.yellow("in_progress");
    case "completed":
      return chalk.green("completed");
    case "failed":
      return chalk.red("failed");
    default:
      return status;
  }
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString();
}

function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + "...";
}

function printAgent(agent: Agent, indent = 0): void {
  const prefix = "  ".repeat(indent);
  console.log(`${prefix}${chalk.bold(agent.id)} [${formatState(agent.state)}]`);
  console.log(`${prefix}  Task: ${truncate(agent.task ?? "No task", 60)}`);
  if (agent.parent) {
    console.log(`${prefix}  Parent: ${agent.parent}`);
  }
  console.log(`${prefix}  Created: ${formatTimestamp(agent.created_at)}`);
}

function printTask(task: Task): void {
  console.log(`${chalk.bold(task.id)} [${formatStatus(task.status)}]`);
  console.log(`  Description: ${truncate(task.description, 60)}`);
  if (task.assigned_agent) {
    console.log(`  Assigned to: ${task.assigned_agent}`);
  }
  console.log(`  Created by: ${task.created_by}`);
  console.log(`  Created: ${formatTimestamp(task.created_at)}`);
}

function printHierarchy(
  agent: Agent,
  getChildren: (id: string) => Agent[],
  indent = 0
): void {
  const prefix = indent > 0 ? "  ".repeat(indent - 1) + "├─ " : "";
  const stateIcon =
    agent.state === "running" ? chalk.green("●") : chalk.gray("○");

  console.log(`${prefix}${stateIcon} ${agent.id}`);
  console.log(`${"  ".repeat(indent)}   ${truncate(agent.task ?? "No task", 50)}`);

  const children = getChildren(agent.id);
  children.forEach((child) => {
    printHierarchy(child, getChildren, indent + 1);
  });
}

// ─────────────────────────────────────────────────────────────────
// CLI Program
// ─────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("multiagent-cli")
  .description("Multi-agent orchestration system CLI")
  .version("0.0.1");

// ─────────────────────────────────────────────────────────────────
// Start Command
// ─────────────────────────────────────────────────────────────────

program
  .command("start")
  .description("Start the multi-agent server")
  .option("-p, --port <port>", "Port to listen on", "3000")
  .option("-h, --host <host>", "Host to bind to", "localhost")
  .option("--cwd <path>", "Working directory for agents")
  .option("--team <name>", "Load team template")
  .action(async (options) => {
    console.log(chalk.blue("Starting multi-agent server..."));

    try {
      // Initialize services
      const eventStore = await createEventStore({ inMemory: false });
      const messageRouter = createMessageRouter(eventStore);
      const agentManager = createAgentManager(eventStore, messageRouter);
      const taskManager = createTaskManager(eventStore);

      // Create task backend from env config
      const taskConfig = loadTaskConfigFromEnv();
      let openTasksClient: { disconnect(): void } | undefined;
      try {
        const result = await createTaskBackend(taskConfig, eventStore);
        openTasksClient = result.openTasksClient;
        console.log(chalk.blue(`Task backend: ${taskConfig.backend.type}`));
      } catch (err) {
        console.log(chalk.yellow(`Task backend creation failed: ${err}. Using legacy TaskManager.`));
      }

      // Determine team name: CLI flag > project config > none
      const projectConfig = loadProjectConfig(options.cwd);
      const teamName = options.team ?? projectConfig.team;

      // Load and initialize team if specified
      let teamRuntime: TeamRuntime | null = null;
      if (teamName) {
        console.log(chalk.blue(`Loading team template '${teamName}'...`));
        const manifest = await loadTeam(
          teamName,
          agentManager.getRoleRegistry(),
          options.cwd
        );
        teamRuntime = new TeamRuntime(manifest, {
          agentManager,
          messageRouter,
          eventStore,
        });
        await teamRuntime.initialize();
        console.log(
          chalk.green(
            `Team '${teamName}' loaded: ${manifest.roles.join(", ")}`
          )
        );
      }

      // Create API server
      const server = createAPIServer(
        { eventStore, agentManager, taskManager, messageRouter },
        { port: parseInt(options.port), host: options.host }
      );

      // Start server
      await server.start();

      console.log(
        chalk.green(`Server running at http://${options.host}:${options.port}`)
      );

      // Bootstrap team agents after server is running
      if (teamRuntime) {
        const { rootId, companionIds } = await teamRuntime.bootstrap();
        console.log(
          chalk.green(
            `Team '${teamName}' bootstrapped: root=${rootId}` +
              (companionIds.length > 0
                ? `, companions=${companionIds.join(", ")}`
                : "")
          )
        );
      }

      console.log(chalk.gray("Press Ctrl+C to stop"));

      // Handle shutdown
      process.on("SIGINT", async () => {
        console.log(chalk.yellow("\nShutting down..."));
        if (teamRuntime) await teamRuntime.teardown();
        await server.stop();
        await agentManager.close();
        try { openTasksClient?.disconnect(); } catch { /* ignore */ }
        await eventStore.close();
        process.exit(0);
      });
    } catch (error) {
      console.error(chalk.red(`Failed to start server: ${error}`));
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────────
// Chat Command
// ─────────────────────────────────────────────────────────────────

program
  .command("chat")
  .description("Start an interactive chat with the head manager")
  .option("--cwd <path>", "Working directory for agents")
  .action(async (options) => {
    const readline = await import("readline");

    console.log(chalk.blue("Initializing multi-agent system..."));

    try {
      // Initialize services
      const eventStore = await createEventStore({ inMemory: false });
      const messageRouter = createMessageRouter(eventStore);
      const agentManager = createAgentManager(eventStore, messageRouter);
      const taskManager = createTaskManager(eventStore);

      // Create head manager
      const headManager = await agentManager.getOrCreateHeadManager({
        cwd: options.cwd ?? process.cwd(),
      });

      console.log(chalk.green(`Head manager ready: ${headManager.id}`));
      console.log(chalk.gray('Type "exit" to quit, "/status" for system status'));
      console.log();

      // Create readline interface
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      // Handle Ctrl+C and SIGTERM to clean up child processes
      const cleanup = async () => {
        console.log(chalk.yellow("\nShutting down..."));
        await agentManager.close();
        await eventStore.close();
        rl.close();
        process.exit(0);
      };
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);

      const prompt = () => {
        rl.question(chalk.cyan("You: "), async (input) => {
          const trimmed = input.trim();

          if (trimmed === "exit" || trimmed === "quit") {
            console.log(chalk.yellow("Goodbye!"));
            await agentManager.close();
            await eventStore.close();
            rl.close();
            return;
          }

          if (trimmed === "/status") {
            const agents = agentManager.list();
            const tasks = taskManager.list();
            console.log();
            console.log(chalk.bold("System Status:"));
            console.log(`  Agents: ${agents.length} total, ${agents.filter((a) => a.state === "running").length} running`);
            console.log(`  Tasks: ${tasks.length} total, ${tasks.filter((t) => t.status === "completed").length} completed`);
            console.log();
            prompt();
            return;
          }

          if (trimmed === "/agents") {
            const agents = agentManager.list();
            console.log();
            if (agents.length === 0) {
              console.log(chalk.gray("No agents"));
            } else {
              agents.forEach((agent) => {
                printAgent(agent);
                console.log();
              });
            }
            prompt();
            return;
          }

          if (trimmed === "/tasks") {
            const tasks = taskManager.list();
            console.log();
            if (tasks.length === 0) {
              console.log(chalk.gray("No tasks"));
            } else {
              tasks.forEach((task) => {
                printTask(task);
                console.log();
              });
            }
            prompt();
            return;
          }

          if (trimmed === "/hierarchy") {
            const headManagers = agentManager.listHeadManagers();
            console.log();
            if (headManagers.length === 0) {
              console.log(chalk.gray("No agents"));
            } else {
              headManagers.forEach((hm) => {
                printHierarchy(hm, (id) => agentManager.getChildren(id));
                console.log();
              });
            }
            prompt();
            return;
          }

          if (!trimmed) {
            prompt();
            return;
          }

          try {
            process.stdout.write(chalk.green("Assistant: "));

            for await (const update of agentManager.prompt(
              headManager.id,
              trimmed
            )) {
              if ("sessionUpdate" in update && update.sessionUpdate === "agent_message_chunk") {
                const chunk = update as { content: { type: string; text?: string } };
                if (chunk.content.type === "text" && chunk.content.text) {
                  process.stdout.write(chunk.content.text);
                }
              }
            }

            console.log();
            console.log();
          } catch (error) {
            console.log();
            console.error(chalk.red(`Error: ${error}`));
            console.log();
          }

          prompt();
        });
      };

      prompt();
    } catch (error) {
      console.error(chalk.red(`Failed to initialize: ${error}`));
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────────
// Status Command
// ─────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Show system status")
  .action(async () => {
    try {
      const eventStore = await createEventStore({ inMemory: false });
      const messageRouter = createMessageRouter(eventStore);
      const agentManager = createAgentManager(eventStore, messageRouter);
      const taskManager = createTaskManager(eventStore);

      const agents = agentManager.list();
      const tasks = taskManager.list();

      console.log();
      console.log(chalk.bold("Multi-Agent System Status"));
      console.log("─".repeat(40));

      console.log();
      console.log(chalk.bold("Agents:"));
      console.log(`  Total: ${agents.length}`);
      console.log(`  Running: ${chalk.green(agents.filter((a) => a.state === "running").length)}`);
      console.log(`  Stopped: ${chalk.gray(agents.filter((a) => a.state === "stopped").length)}`);

      console.log();
      console.log(chalk.bold("Tasks:"));
      console.log(`  Total: ${tasks.length}`);
      console.log(`  Pending: ${chalk.gray(tasks.filter((t) => t.status === "pending").length)}`);
      console.log(`  In Progress: ${chalk.yellow(tasks.filter((t) => t.status === "in_progress").length)}`);
      console.log(`  Completed: ${chalk.green(tasks.filter((t) => t.status === "completed").length)}`);
      console.log(`  Failed: ${chalk.red(tasks.filter((t) => t.status === "failed").length)}`);

      console.log();

      await eventStore.close();
    } catch (error) {
      console.error(chalk.red(`Failed to get status: ${error}`));
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────────
// Agents Command
// ─────────────────────────────────────────────────────────────────

program
  .command("agents [id]")
  .description("List agents or show agent details")
  .option("-s, --state <state>", "Filter by state (running, stopped)")
  .action(async (id, options) => {
    try {
      const eventStore = await createEventStore({ inMemory: false });
      const messageRouter = createMessageRouter(eventStore);
      const agentManager = createAgentManager(eventStore, messageRouter);

      if (id) {
        // Show specific agent
        const agent = agentManager.get(id);
        if (!agent) {
          console.error(chalk.red(`Agent not found: ${id}`));
          await eventStore.close();
          process.exit(1);
        }

        console.log();
        console.log(chalk.bold("Agent Details"));
        console.log("─".repeat(40));
        console.log(`  ID: ${agent.id}`);
        console.log(`  Session: ${agent.session_id}`);
        console.log(`  State: ${formatState(agent.state)}`);
        console.log(`  Task: ${agent.task ?? "No task"}`);
        console.log(`  Parent: ${agent.parent ?? "None (head manager)"}`);
        console.log(`  Lineage: ${agent.lineage.length > 0 ? agent.lineage.join(" → ") : "None"}`);
        console.log(`  Created: ${formatTimestamp(agent.created_at)}`);
        if (agent.started_at) {
          console.log(`  Started: ${formatTimestamp(agent.started_at)}`);
        }
        if (agent.stopped_at) {
          console.log(`  Stopped: ${formatTimestamp(agent.stopped_at)}`);
          console.log(`  Stop Reason: ${agent.stop_reason ?? "Unknown"}`);
        }

        const children = agentManager.getChildren(id);
        if (children.length > 0) {
          console.log();
          console.log(chalk.bold("Children:"));
          children.forEach((child) => {
            console.log(`  ${child.id} [${formatState(child.state)}]`);
          });
        }

        console.log();
      } else {
        // List all agents
        let agents = agentManager.list();

        if (options.state) {
          agents = agents.filter((a) => a.state === options.state);
        }

        console.log();
        if (agents.length === 0) {
          console.log(chalk.gray("No agents found"));
        } else {
          console.log(chalk.bold(`Agents (${agents.length}):`));
          console.log("─".repeat(40));
          agents.forEach((agent) => {
            printAgent(agent);
            console.log();
          });
        }
      }

      await eventStore.close();
    } catch (error) {
      console.error(chalk.red(`Failed to list agents: ${error}`));
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────────
// Tasks Command
// ─────────────────────────────────────────────────────────────────

program
  .command("tasks [id]")
  .description("List tasks or show task details")
  .option("-s, --status <status>", "Filter by status")
  .action(async (id, options) => {
    try {
      const eventStore = await createEventStore({ inMemory: false });
      const taskManager = createTaskManager(eventStore);

      if (id) {
        // Show specific task
        const task = taskManager.get(id);
        if (!task) {
          console.error(chalk.red(`Task not found: ${id}`));
          await eventStore.close();
          process.exit(1);
        }

        console.log();
        console.log(chalk.bold("Task Details"));
        console.log("─".repeat(40));
        console.log(`  ID: ${task.id}`);
        console.log(`  Status: ${formatStatus(task.status)}`);
        console.log(`  Description: ${task.description}`);
        console.log(`  Created by: ${task.created_by}`);
        if (task.assigned_agent) {
          console.log(`  Assigned to: ${task.assigned_agent}`);
        }
        if (task.parent_task) {
          console.log(`  Parent Task: ${task.parent_task}`);
        }
        console.log(`  Created: ${formatTimestamp(task.created_at)}`);
        if (task.started_at) {
          console.log(`  Started: ${formatTimestamp(task.started_at)}`);
        }
        if (task.completed_at) {
          console.log(`  Completed: ${formatTimestamp(task.completed_at)}`);
        }

        if (task.subtasks && task.subtasks.length > 0) {
          console.log();
          console.log(chalk.bold("Subtasks:"));
          task.subtasks.forEach((subtaskId) => {
            const subtask = taskManager.get(subtaskId);
            if (subtask) {
              console.log(`  ${subtask.id} [${formatStatus(subtask.status)}]`);
            }
          });
        }

        console.log();
      } else {
        // List all tasks
        let tasks = taskManager.list();

        if (options.status) {
          tasks = tasks.filter((t) => t.status === options.status);
        }

        console.log();
        if (tasks.length === 0) {
          console.log(chalk.gray("No tasks found"));
        } else {
          console.log(chalk.bold(`Tasks (${tasks.length}):`));
          console.log("─".repeat(40));
          tasks.forEach((task) => {
            printTask(task);
            console.log();
          });
        }
      }

      await eventStore.close();
    } catch (error) {
      console.error(chalk.red(`Failed to list tasks: ${error}`));
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────────
// Hierarchy Command
// ─────────────────────────────────────────────────────────────────

program
  .command("hierarchy [rootId]")
  .description("Show agent hierarchy tree")
  .action(async (rootId) => {
    try {
      const eventStore = await createEventStore({ inMemory: false });
      const messageRouter = createMessageRouter(eventStore);
      const agentManager = createAgentManager(eventStore, messageRouter);

      console.log();
      console.log(chalk.bold("Agent Hierarchy"));
      console.log("─".repeat(40));
      console.log();

      if (rootId) {
        const agent = agentManager.get(rootId);
        if (!agent) {
          console.error(chalk.red(`Agent not found: ${rootId}`));
          await eventStore.close();
          process.exit(1);
        }
        printHierarchy(agent, (id) => agentManager.getChildren(id));
      } else {
        const headManagers = agentManager.listHeadManagers();
        if (headManagers.length === 0) {
          console.log(chalk.gray("No agents found"));
        } else {
          headManagers.forEach((hm) => {
            printHierarchy(hm, (id) => agentManager.getChildren(id));
            console.log();
          });
        }
      }

      console.log();
      await eventStore.close();
    } catch (error) {
      console.error(chalk.red(`Failed to show hierarchy: ${error}`));
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────────
// Clear Command
// ─────────────────────────────────────────────────────────────────

program
  .command("clear")
  .description("Clear all data and reset the system")
  .option("-y, --yes", "Skip confirmation")
  .action(async (options) => {
    if (!options.yes) {
      const readline = await import("readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await new Promise<string>((resolve) => {
        rl.question(
          chalk.yellow("Are you sure you want to clear all data? (y/N) "),
          resolve
        );
      });
      rl.close();

      if (answer.toLowerCase() !== "y") {
        console.log("Cancelled");
        return;
      }
    }

    try {
      const fs = await import("fs");
      const path = await import("path");
      const os = await import("os");

      const storagePath = path.join(os.homedir(), ".multiagent", "store.json");

      if (fs.existsSync(storagePath)) {
        fs.unlinkSync(storagePath);
        console.log(chalk.green("Data cleared successfully"));
      } else {
        console.log(chalk.gray("No data to clear"));
      }
    } catch (error) {
      console.error(chalk.red(`Failed to clear data: ${error}`));
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────────
// Stop Command
// ─────────────────────────────────────────────────────────────────

program
  .command("stop [agentId]")
  .description("Stop an agent or all agents")
  .option("-a, --all", "Stop all running agents")
  .action(async (agentId, options) => {
    try {
      const eventStore = await createEventStore({ inMemory: false });
      const messageRouter = createMessageRouter(eventStore);
      const agentManager = createAgentManager(eventStore, messageRouter);

      if (options.all) {
        const runningAgents = agentManager.list({ state: "running" });
        console.log(`Stopping ${runningAgents.length} agents...`);

        for (const agent of runningAgents) {
          try {
            await agentManager.terminate(agent.id, "cancelled");
            console.log(chalk.green(`Stopped: ${agent.id}`));
          } catch (error) {
            console.error(chalk.red(`Failed to stop ${agent.id}: ${error}`));
          }
        }
      } else if (agentId) {
        const agent = agentManager.get(agentId);
        if (!agent) {
          console.error(chalk.red(`Agent not found: ${agentId}`));
          await eventStore.close();
          process.exit(1);
        }

        await agentManager.terminate(agentId, "cancelled");
        console.log(chalk.green(`Stopped: ${agentId}`));
      } else {
        console.error(chalk.red("Please specify an agent ID or use --all"));
        process.exit(1);
      }

      await eventStore.close();
    } catch (error) {
      console.error(chalk.red(`Failed to stop agent: ${error}`));
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────────
// ACP Command
// ─────────────────────────────────────────────────────────────────

program
  .command("acp")
  .description("Run as an ACP-compliant agent (for use with acp-factory)")
  .option("--cwd <path>", "Working directory for agents")
  .action(async (options) => {
    // Import and run the ACP server
    // We dynamically import to avoid loading ACP dependencies in other commands
    const { Readable } = await import("node:stream");
    const { AgentSideConnection, ndJsonStream } = await import(
      "@agentclientprotocol/sdk"
    );
    const { MacroAgent } = await import("../acp/macro-agent.js");

    const defaultCwd = options.cwd ?? process.cwd();

    let eventStore: Awaited<ReturnType<typeof createEventStore>> | null = null;
    let agentManager: ReturnType<typeof createAgentManager> | null = null;

    try {
      // Initialize services
      eventStore = await createEventStore({ inMemory: false });
      const messageRouter = createMessageRouter(eventStore);
      agentManager = createAgentManager(eventStore, messageRouter);
      const taskManager = createTaskManager(eventStore);

      // Create task backend from env config
      const taskConfig = loadTaskConfigFromEnv();
      let openTasksClient: { disconnect(): void } | undefined;
      try {
        const result = await createTaskBackend(taskConfig, eventStore);
        openTasksClient = result.openTasksClient;
      } catch { /* non-critical for acp command */ }

      // Create stdio streams for ACP communication
      const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
      const output = new WritableStream<Uint8Array>({
        write(chunk) {
          return new Promise((resolve, reject) => {
            const canContinue = process.stdout.write(chunk, (err) => {
              if (err) reject(err);
              else if (canContinue) resolve();
            });
            if (!canContinue) {
              process.stdout.once("drain", resolve);
            }
          });
        },
      });

      const stream = ndJsonStream(output, input);

      // Create ACP connection with MacroAgent
      const connection = new AgentSideConnection(
        (conn) =>
          new MacroAgent(conn, {
            agentManager: agentManager!,
            eventStore: eventStore!,
            taskManager,
            defaultCwd,
          }),
        stream
      );

      // Handle graceful shutdown
      const cleanup = async () => {
        if (agentManager) {
          await agentManager.close();
        }
        try { openTasksClient?.disconnect(); } catch { /* ignore */ }
        if (eventStore) {
          await eventStore.close();
        }
        process.exit(0);
      };

      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);

      // Wait for connection to close
      await connection.closed;
      await cleanup();
    } catch (error) {
      console.error(`ACP server error: ${error}`);
      if (agentManager) {
        try {
          await agentManager.close();
        } catch {
          // Ignore
        }
      }
      if (eventStore) {
        try {
          await eventStore.close();
        } catch {
          // Ignore
        }
      }
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────────
// Parse and Run
// ─────────────────────────────────────────────────────────────────

program.parse();
