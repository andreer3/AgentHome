import os from "node:os";
import path from "node:path";
import { commandExists, exists, readText } from "../core/files.js";
import { planJsoncProperties, planOwnedFile } from "../core/plan.js";
import { globalRoot, resolveCliPath } from "../core/paths.js";
import { MANAGED_HEADER, MANAGED_MARKER, resolveConfigSlot } from "./opencode-slots.js";
import type { McpRegistry } from "../config/schema.js";
import type { ApplyContext, HarnessAdapter } from "./types.js";

type McpServers = McpRegistry["servers"];

function filterServers(registry: McpRegistry): McpServers {
  return Object.fromEntries(
    Object.entries(registry.servers).filter(([, server]) => !server.targets || server.targets.includes("opencode")),
  );
}

function toOpenCodeMcp(servers: McpServers): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (server.type === "local") {
      result[name] = {
        type: "local",
        command: server.command,
        enabled: server.enabled,
        ...(server.environment ? { environment: server.environment } : {}),
      };
    } else {
      result[name] = {
        type: "remote",
        url: server.url,
        enabled: server.enabled,
        ...(server.headers ? { headers: server.headers } : {}),
      };
    }
  }
  return result;
}

function globalConfigFile(): string {
  return path.join(os.homedir(), ".config", "opencode", "opencode.jsonc");
}

function projectConfigFile(cwd: string): string {
  return path.join(cwd, "opencode.jsonc");
}

async function globalInstructionPaths(): Promise<string[]> {
  const root = globalRoot();
  const candidates = [path.join(root, "rules", "global.md"), path.join(root, "memory", "global.md")];
  const result: string[] = [];
  for (const candidate of candidates) if (await exists(candidate)) result.push(candidate);
  return result;
}

async function projectInstructionPaths(cwd: string): Promise<string[]> {
  const candidates = [
    { abs: path.join(cwd, ".agenthome", "rules.md"), rel: ".agenthome/rules.md" },
    { abs: path.join(cwd, ".agenthome", "memory.md"), rel: ".agenthome/memory.md" },
  ];
  const result: string[] = [];
  for (const candidate of candidates) if (await exists(candidate.abs)) result.push(candidate.rel);
  return result;
}

async function openCodeProps(
  ctx: ApplyContext,
  registry: McpRegistry,
  instructions: string[],
): Promise<Record<string, unknown>> {
  const props: Record<string, unknown> = {};
  if (instructions.length) props.instructions = instructions;
  const servers = filterServers(registry);
  if (Object.keys(servers).length) props.mcp = toOpenCodeMcp(servers);
  if (ctx.providers.defaults) props.model = `${ctx.providers.defaults.provider}/${ctx.providers.defaults.model}`;
  return props;
}

/** Auto-discovered OpenCode plugin that registers the project when a session starts. */
function openCodeHookContent(): string {
  const node = process.execPath;
  const cli = resolveCliPath();
  return `${MANAGED_HEADER}
import { existsSync } from "node:fs"
import { spawn } from "node:child_process"

const NODE = ${JSON.stringify(node)}
const CLI = ${JSON.stringify(cli)}

function register(directory: string): void {
  const args = ["register", "--path", directory, "--harness", "opencode"]
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

export const AgentHomeRegister = async ({ directory }: any) => {
  if (typeof directory === "string" && directory.length > 0) register(directory)
  return {
    event: async ({ event }: any) => {
      if (event?.type !== "session.created") return
      const info = event?.properties?.info
      if (!info || info.parentID) return
      if (typeof info.directory === "string" && info.directory.length > 0) register(info.directory)
    },
  }
}
`;
}

/** Auto-discovered OpenCode custom tool: AgentHome's project router. */
function openCodeRouteToolContent(): string {
  const node = process.execPath;
  const cli = resolveCliPath();
  return `${MANAGED_HEADER}
import { tool } from "@opencode-ai/plugin"
import { existsSync } from "node:fs"
import { spawn } from "node:child_process"

const NODE = ${JSON.stringify(node)}
const CLI = ${JSON.stringify(cli)}

function runRoute(query: string): Promise<string> {
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
      child.on("error", (error) => resolve("AgentHome route failed: " + error.message))
      child.on("close", (code) => {
        if (code === 0) resolve(stdout.trim())
        else resolve("AgentHome route failed (" + code + "): " + (stderr || stdout).trim())
      })
    } catch (error) {
      resolve("AgentHome route failed: " + (error instanceof Error ? error.message : String(error)))
    }
  })
}

export default tool({
  description:
    "AgentHome project router. Use it whenever a task refers to another project: given a query (slug, alias, folder name or path) it returns the absolute paths of that project's memory, rules, skills and MCP files. Read the returned paths on demand and never copy their contents into global memory.",
  args: { query: tool.schema.string().describe("Project slug, alias, folder name or path") },
  async execute(args) {
    return await runRoute(args.query)
  },
})
`;
}

export const openCodeAdapter: HarnessAdapter = {
  name: "opencode",
  detect: () => commandExists("opencode"),

  async status(cwd) {
    const globalDir = path.join(os.homedir(), ".config", "opencode");
    const globalJsonc = path.join(globalDir, "opencode.jsonc");
    const globalJson = path.join(globalDir, "opencode.json");
    const projectJsonc = path.join(cwd, "opencode.jsonc");
    const projectJson = path.join(cwd, "opencode.json");
    const managed = async (file: string) =>
      (await exists(file)) && (await readText(file)).includes(MANAGED_MARKER);
    return [
      `binary: ${(await commandExists("opencode")) ? "found" : "not found"}`,
      `global config: ${(await exists(globalJsonc)) ? globalJsonc : (await exists(globalJson)) ? globalJson : "not found"}`,
      `global AgentHome file: ${(await managed(globalJsonc)) ? "yes" : (await managed(globalJson)) ? "yes" : "no"}`,
      `project config: ${(await exists(projectJsonc)) ? projectJsonc : (await exists(projectJson)) ? projectJson : "not found"}`,
      "rules: injected via instructions (AGENTS.md is left untouched and still loaded)",
    ];
  },

  async plan(ctx) {
    if (ctx.scope === "global" || ctx.scope === "all") {
      const props = await openCodeProps(ctx, ctx.mcpGlobal, await globalInstructionPaths());
      if (Object.keys(props).length) {
        const slot = await resolveConfigSlot(globalConfigFile());
        await planJsoncProperties(ctx.plan, slot.file, props, {
          force: ctx.force,
          owned: slot.owned,
          header: MANAGED_HEADER,
        });
      }

      const hook = path.join(os.homedir(), ".config", "opencode", "plugins", "agenthome-register.ts");
      await planOwnedFile(ctx.plan, hook, openCodeHookContent());

      const routeTool = path.join(os.homedir(), ".config", "opencode", "tool", "agenthome-route.ts");
      await planOwnedFile(ctx.plan, routeTool, openCodeRouteToolContent());
    }

    if (ctx.scope === "project" || ctx.scope === "all") {
      const props = await openCodeProps(ctx, ctx.mcpProject, await projectInstructionPaths(ctx.cwd));
      if (Object.keys(props).length) {
        const slot = await resolveConfigSlot(projectConfigFile(ctx.cwd));
        await planJsoncProperties(ctx.plan, slot.file, props, {
          force: ctx.force,
          owned: slot.owned,
          header: MANAGED_HEADER,
        });
      }
    }
  },
};
