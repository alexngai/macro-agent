import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ACPServerOptions {
  /** Working directory for agents */
  cwd?: string;
  /** Stdio ACP-only mode (for embedded use with acp-factory) */
  acp?: boolean;
  /** Port for server (default: 3001) */
  port?: number;
  /** Host for server (default: localhost) */
  host?: string;
  /** Instance ID to reuse an existing event store (omit for new instance) */
  instanceId?: string;
}

/**
 * Parse command line arguments.
 * @param argv Optional array of arguments (defaults to process.argv.slice(2))
 */
export function parseArgs(argv?: string[]): ACPServerOptions {
  const args = argv ?? process.argv.slice(2);
  const options: ACPServerOptions = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--version" || args[i] === "-v") {
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));
      console.log(pkg.version);
      process.exit(0);
    } else if (args[i] === "--cwd" && args[i + 1]) {
      options.cwd = args[i + 1];
      i++;
    } else if (args[i] === "--acp") {
      options.acp = true;
    } else if (args[i] === "--port" && args[i + 1]) {
      options.port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--host" && args[i + 1]) {
      options.host = args[i + 1];
      i++;
    } else if (args[i] === "--instance-id" && args[i + 1]) {
      options.instanceId = args[i + 1];
      i++;
    }
  }

  return options;
}
