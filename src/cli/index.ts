#!/usr/bin/env node
/**
 * Multi-Agent CLI (V2)
 *
 * Command-line interface for inspecting and managing the multi-agent system.
 *
 * Usage:
 *   multiagent-cli <command> [options]
 */

import { Command } from "commander";
import chalk from "chalk";
import { bootV2 } from "../boot-v2.js";
import type { Agent } from "../store/types/index.js";

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

function printHierarchy(
  agent: Agent,
  getChildren: (id: string) => Agent[],
  indent = 0
): void {
  const prefix = indent > 0 ? "  ".repeat(indent - 1) + "|- " : "";
  const stateIcon =
    agent.state === "running" ? chalk.green("*") : chalk.gray("o");

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
  .action(async (options) => {
    console.log(chalk.blue("Starting multi-agent server (V2)..."));

    try {
      const system = await bootV2({
        cwd: options.cwd ?? process.cwd(),
      });

      console.log(chalk.green("System booted successfully."));

      // Handle shutdown
      process.on("SIGINT", async () => {
        console.log(chalk.yellow("\nShutting down..."));
        await system.shutdown();
        process.exit(0);
      });

      console.log(chalk.gray("Press Ctrl+C to stop"));
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

    console.log(chalk.blue("Initializing multi-agent system (V2)..."));

    try {
      const system = await bootV2({
        cwd: options.cwd ?? process.cwd(),
      });

      // Create head manager
      const headManager = await system.agentManager.getOrCreateHeadManager({
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
        await system.shutdown();
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
            await system.shutdown();
            rl.close();
            return;
          }

          if (trimmed === "/status") {
            const agents = system.agentManager.list();
            console.log();
            console.log(chalk.bold("System Status:"));
            console.log(`  Agents: ${agents.length} total, ${agents.filter((a) => a.state === "running").length} running`);
            console.log();
            prompt();
            return;
          }

          if (trimmed === "/agents") {
            const agents = system.agentManager.list();
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

          if (trimmed === "/hierarchy") {
            const headManagers = system.agentManager.listHeadManagers();
            console.log();
            if (headManagers.length === 0) {
              console.log(chalk.gray("No agents"));
            } else {
              headManagers.forEach((hm) => {
                printHierarchy(hm, (id) => system.agentManager.getChildren(id));
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

            for await (const update of system.agentManager.prompt(
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
      const system = await bootV2();

      const agents = system.agentManager.list();

      console.log();
      console.log(chalk.bold("Multi-Agent System Status"));
      console.log("-".repeat(40));

      console.log();
      console.log(chalk.bold("Agents:"));
      console.log(`  Total: ${agents.length}`);
      console.log(`  Running: ${chalk.green(agents.filter((a) => a.state === "running").length)}`);
      console.log(`  Stopped: ${chalk.gray(agents.filter((a) => a.state === "stopped").length)}`);

      console.log();

      await system.shutdown();
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
      const system = await bootV2();

      if (id) {
        // Show specific agent
        const agent = system.agentManager.get(id);
        if (!agent) {
          console.error(chalk.red(`Agent not found: ${id}`));
          await system.shutdown();
          process.exit(1);
        }

        console.log();
        console.log(chalk.bold("Agent Details"));
        console.log("-".repeat(40));
        console.log(`  ID: ${agent.id}`);
        console.log(`  Session: ${agent.session_id}`);
        console.log(`  State: ${formatState(agent.state)}`);
        console.log(`  Task: ${agent.task ?? "No task"}`);
        console.log(`  Parent: ${agent.parent ?? "None (head manager)"}`);
        console.log(`  Created: ${formatTimestamp(agent.created_at)}`);

        const children = system.agentManager.getChildren(id);
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
        let agents = system.agentManager.list();

        if (options.state) {
          agents = agents.filter((a) => a.state === options.state);
        }

        console.log();
        if (agents.length === 0) {
          console.log(chalk.gray("No agents found"));
        } else {
          console.log(chalk.bold(`Agents (${agents.length}):`));
          console.log("-".repeat(40));
          agents.forEach((agent) => {
            printAgent(agent);
            console.log();
          });
        }
      }

      await system.shutdown();
    } catch (error) {
      console.error(chalk.red(`Failed to list agents: ${error}`));
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
      const system = await bootV2();

      console.log();
      console.log(chalk.bold("Agent Hierarchy"));
      console.log("-".repeat(40));
      console.log();

      if (rootId) {
        const agent = system.agentManager.get(rootId);
        if (!agent) {
          console.error(chalk.red(`Agent not found: ${rootId}`));
          await system.shutdown();
          process.exit(1);
        }
        printHierarchy(agent, (id) => system.agentManager.getChildren(id));
      } else {
        const headManagers = system.agentManager.listHeadManagers();
        if (headManagers.length === 0) {
          console.log(chalk.gray("No agents found"));
        } else {
          headManagers.forEach((hm) => {
            printHierarchy(hm, (id) => system.agentManager.getChildren(id));
            console.log();
          });
        }
      }

      console.log();
      await system.shutdown();
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

      const baseDir = process.env.MACRO_AGENT_HOME || path.join(os.homedir(), ".multiagent");
      const storagePath = path.join(baseDir, "store.json");

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
      const system = await bootV2();

      if (options.all) {
        const runningAgents = system.agentManager.list({ state: "running" });
        console.log(`Stopping ${runningAgents.length} agents...`);

        for (const agent of runningAgents) {
          try {
            await system.agentManager.terminate(agent.id, "cancelled");
            console.log(chalk.green(`Stopped: ${agent.id}`));
          } catch (error) {
            console.error(chalk.red(`Failed to stop ${agent.id}: ${error}`));
          }
        }
      } else if (agentId) {
        const agent = system.agentManager.get(agentId);
        if (!agent) {
          console.error(chalk.red(`Agent not found: ${agentId}`));
          await system.shutdown();
          process.exit(1);
        }

        await system.agentManager.terminate(agentId, "cancelled");
        console.log(chalk.green(`Stopped: ${agentId}`));
      } else {
        console.error(chalk.red("Please specify an agent ID or use --all"));
        process.exit(1);
      }

      await system.shutdown();
    } catch (error) {
      console.error(chalk.red(`Failed to stop agent: ${error}`));
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────────
// Parse and Run
// ─────────────────────────────────────────────────────────────────

program.parse();
