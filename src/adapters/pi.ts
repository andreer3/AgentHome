import os from "node:os";
import path from "node:path";
import { commandExists, exists } from "../core/files.js";
import { planJsoncProperties, planManagedBlock, planOwnedFile } from "../core/plan.js";
import { resolveCliPath } from "../core/paths.js";
import { MANAGED_HEADER } from "../core/managed.js";
import { compileMarkdownSources } from "../core/compile.js";
import type { McpRegistry } from "../config/schema.js";
import type { ApplyContext, HarnessAdapter } from "./types.js";

type McpServers = McpRegistry["servers"];

function filterServers(registry: McpRegistry): McpServers {
  return Object.fromEntries(
    Object.entries(registry.servers)
      // pi-mcp-extension has no `enabled` field: a disabled server must not be emitted.
      .filter(([, server]) => server.enabled !== false)
      .filter(([, server]) => !server.targets || server.targets.includes("pi")),
  );
}

function toPiMcp(servers: McpServers): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (server.type === "local") {
      const [command, ...args] = server.command ?? [];
      result[name] = {
        transport: "stdio",
        command,
        args,
        lifecycle: server.lifecycle,
        ...(server.environment ? { env: server.environment } : {}),
      };
    } else {
      // pi-mcp-extension supports streamable-http and SSE. Canonical remote maps to streamable-http.
      result[name] = {
        transport: "streamable-http",
        url: server.url,
        lifecycle: server.lifecycle,
        ...(server.headers ? { headers: server.headers } : {}),
      };
    }
  }
  return result;
}

function piSettingsProps(ctx: ApplyContext): Record<string, unknown> {
  if (!ctx.providers.defaults) return {};
  return {
    defaultProvider: ctx.providers.defaults.provider,
    defaultModel: ctx.providers.defaults.model,
  };
}

/** Auto-discovered Pi extension that registers the project when a session starts. */
function piHookContent(): string {
  const node = process.execPath;
  const cli = resolveCliPath();
  return `${MANAGED_HEADER}
import { existsSync } from "node:fs"
import { spawn } from "node:child_process"

const NODE = ${JSON.stringify(node)}
const CLI = ${JSON.stringify(cli)}

function register(directory: string): void {
  const args = ["register", "--path", directory, "--harness", "pi"]
  try {
    const useEmbedded = existsSync(NODE) && existsSync(CLI)
    const child = spawn(useEmbedded ? NODE : "agenthome", useEmbedded ? [CLI, ...args] : args, {
      detached: true,
      stdio: "ignore",
    })
    child.on("error", () => {})
    child.unref()
  } catch {
    // never break harness startup
  }
}

export default async function (pi: any): Promise<void> {
  try {
    pi.on("session_start", async (_event: any, ctx: any) => {
      if (typeof ctx?.cwd === "string" && ctx.cwd.length > 0) register(ctx.cwd)
    })
  } catch {
    // never break harness startup
  }
}
`;
}

/** Auto-discovered Pi extension tool: AgentHome's project router. */
function piRouteToolContent(): string {
  const node = process.execPath;
  const cli = resolveCliPath();
  return `${MANAGED_HEADER}
import { existsSync } from "node:fs"
import { spawn } from "node:child_process"

const NODE = ${JSON.stringify(node)}
const CLI = ${JSON.stringify(cli)}

const parameters = {
  type: "object",
  properties: {
    query: { type: "string", description: "Project slug, alias, folder name or path" },
  },
  required: ["query"],
} as any

function runRoute(query: string): Promise<{ text: string; code: number | null }> {
  return new Promise((resolve) => {
    const useEmbedded = existsSync(NODE) && existsSync(CLI)
    const command = useEmbedded ? NODE : "agenthome"
    const args = useEmbedded ? [CLI, "route", query, "--json"] : ["route", query, "--json"]
    try {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (chunk) => { stdout += String(chunk) })
      child.stderr.on("data", (chunk) => { stderr += String(chunk) })
      child.on("error", (error) => resolve({ text: "AgentHome route failed: " + error.message, code: null }))
      child.on("close", (code) => {
        if (code === 0) resolve({ text: stdout.trim(), code })
        else resolve({ text: "AgentHome route failed (" + code + "): " + (stderr || stdout).trim(), code })
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      resolve({ text: "AgentHome route failed: " + message, code: null })
    }
  })
}

export default async function (pi: any): Promise<void> {
  try {
    pi.registerTool({
      name: "agenthome_route",
      label: "AgentHome Route",
      description:
        "AgentHome project router. Use it whenever a task refers to another project: given a query (slug, alias, folder name or path) it returns the absolute paths of that project's memory, rules, skills and MCP files. Read the returned paths on demand and never copy their contents into global memory.",
      parameters,
      async execute(_toolCallId: string, params: any) {
        const result = await runRoute(String(params?.query ?? ""))
        return { content: [{ type: "text", text: result.text }], details: { code: result.code } }
      },
    })
  } catch {
    // never break harness startup
  }
}
`;
}

export const piAdapter: HarnessAdapter = {
  name: "pi",
  detect: () => commandExists("pi"),

  async status(cwd) {
    const globalSettings = path.join(os.homedir(), ".pi", "agent", "settings.json");
    const projectSettings = path.join(cwd, ".pi", "settings.json");
    return [
      `binary: ${(await commandExists("pi")) ? "found" : "not found"}`,
      `global settings: ${(await exists(globalSettings)) ? globalSettings : "not found"}`,
      `project settings: ${(await exists(projectSettings)) ? projectSettings : "not found"}`,
      "MCP note: generated mcp.json expects the community pi-mcp-extension package",
    ];
  },

  async plan(ctx) {
    const globalRules = await compileMarkdownSources(ctx.config.sources.global.rules, ctx.cwd, "Global rule");
    const globalMemory = await compileMarkdownSources(ctx.config.sources.global.memory, ctx.cwd, "Global memory");
    const projectRules = await compileMarkdownSources(ctx.config.sources.project.rules, ctx.cwd, "Project rule");
    const projectMemory = await compileMarkdownSources(ctx.config.sources.project.memory, ctx.cwd, "Project memory");

    if (ctx.scope === "global" || ctx.scope === "all") {
      const agents = path.join(os.homedir(), ".pi", "agent", "AGENTS.md");
      await planManagedBlock(ctx.plan, agents, "global", [globalRules, globalMemory].filter(Boolean).join("\n\n"));

      const settings = path.join(os.homedir(), ".pi", "agent", "settings.json");
      await planJsoncProperties(ctx.plan, settings, piSettingsProps(ctx), { force: ctx.force });

      const servers = filterServers(ctx.mcpGlobal);
      if (Object.keys(servers).length) {
        const mcp = path.join(os.homedir(), ".pi", "agent", "mcp.json");
        await planJsoncProperties(ctx.plan, mcp, { mcpServers: toPiMcp(servers) }, { force: ctx.force });
      }

      const hook = path.join(os.homedir(), ".pi", "agent", "extensions", "agenthome-register.ts");
      await planOwnedFile(ctx.plan, hook, piHookContent());

      const routeTool = path.join(os.homedir(), ".pi", "agent", "extensions", "agenthome-route.ts");
      await planOwnedFile(ctx.plan, routeTool, piRouteToolContent());
    }

    if (ctx.scope === "project" || ctx.scope === "all") {
      // Project AGENTS.md is shared by OpenCode and Pi. Same AgentHome block => idempotent.
      const agents = path.join(ctx.cwd, "AGENTS.md");
      await planManagedBlock(ctx.plan, agents, "project", [projectRules, projectMemory].filter(Boolean).join("\n\n"));

      const settings = path.join(ctx.cwd, ".pi", "settings.json");
      await planJsoncProperties(ctx.plan, settings, piSettingsProps(ctx), { force: ctx.force });

      const servers = filterServers(ctx.mcpProject);
      if (Object.keys(servers).length) {
        const mcp = path.join(ctx.cwd, ".pi", "mcp.json");
        await planJsoncProperties(ctx.plan, mcp, { mcpServers: toPiMcp(servers) }, { force: ctx.force });
      }
    }
  },
};
