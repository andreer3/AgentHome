import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { parse } from "jsonc-parser";
import { isDeepStrictEqual } from "node:util";
import {
  mcpRegistrySchema,
  mcpServerSchema,
  providersSchema,
  type AgentHomeConfig,
  type McpRegistry,
  type ProvidersConfig,
} from "../config/schema.js";
import { exists } from "./files.js";
import { ApplyPlan } from "./plan.js";
import { resolveSourcePath } from "./paths.js";
import { MANAGED_MARKER } from "./managed.js";

export interface AdoptionScopeOptions {
  scope: "global" | "project";
  cwd: string;
  force: boolean;
}

export interface AdoptionReport {
  sources: string[];
  importedServers: string[];
  keptServers: string[];
  clashServers: string[];
  replacedServers: string[];
  invalidServers: { name: string; reason: string }[];
  model?: string;
  modelKept: boolean;
  modelClash: boolean;
  modelReplaced: boolean;
  modelInvalid?: string;
}

export interface AdoptionResult {
  plan: ApplyPlan;
  report: AdoptionReport;
}

function readJsoncObject(file: string, text: string): Record<string, unknown> {
  const errors: { error: number; offset: number; length: number }[] = [];
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error(`Cannot adopt invalid JSON/JSONC: ${file}`);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Cannot adopt JSON/JSONC that is not an object: ${file}`);
  }
  return parsed as Record<string, unknown>;
}

function candidateFiles(scope: "global" | "project", cwd: string): string[] {
  if (scope === "global") {
    const dir = path.join(os.homedir(), ".config", "opencode");
    return [path.join(dir, "opencode.json"), path.join(dir, "opencode.jsonc")];
  }
  return [path.join(cwd, "opencode.json"), path.join(cwd, "opencode.jsonc")];
}

async function readOpenCodeConfig(files: string[]): Promise<{ config: Record<string, unknown>; used: string[] }> {
  const config: Record<string, unknown> = {};
  const used: string[] = [];
  for (const file of files) {
    if (!(await exists(file))) continue;
    const text = await fs.readFile(file, "utf8");
    if (text.includes(MANAGED_MARKER)) continue;
    Object.assign(config, readJsoncObject(file, text));
    used.push(file);
  }
  return { config, used };
}

/**
 * Reads the user's existing OpenCode config and plans adoption of its `mcp`
 * servers and `model` into AgentHome's canonical files. Existing AgentHome
 * entries are kept unless `force` is set; differing entries are reported as clashes.
 */
export async function planAdoption(config: AgentHomeConfig, options: AdoptionScopeOptions): Promise<AdoptionResult> {
  const { config: opencodeConfig, used } = await readOpenCodeConfig(candidateFiles(options.scope, options.cwd));
  const report: AdoptionReport = {
    sources: used,
    importedServers: [],
    keptServers: [],
    clashServers: [],
    replacedServers: [],
    invalidServers: [],
    modelKept: false,
    modelClash: false,
    modelReplaced: false,
  };
  const plan = new ApplyPlan();
  if (!used.length) return { plan, report };

  const registryFile = resolveSourcePath(config.mcpRegistry ?? "~/.agenthome/mcp/registry.yaml", options.cwd);
  let registryBefore: string | null = null;
  let registry: McpRegistry = { servers: {} };
  if (await exists(registryFile)) {
    registryBefore = await fs.readFile(registryFile, "utf8");
    registry = mcpRegistrySchema.parse(YAML.parse(registryBefore));
  }

  const rawMcp = opencodeConfig.mcp;
  if (rawMcp && typeof rawMcp === "object" && !Array.isArray(rawMcp)) {
    for (const [name, raw] of Object.entries(rawMcp as Record<string, unknown>)) {
      const parsed = mcpServerSchema.safeParse(raw);
      if (!parsed.success) {
        report.invalidServers.push({ name, reason: parsed.error.issues.map((issue) => issue.message).join("; ") });
        continue;
      }
      const existing = registry.servers[name];
      if (existing) {
        if (isDeepStrictEqual(existing, parsed.data)) {
          report.keptServers.push(name);
        } else if (options.force) {
          registry.servers[name] = parsed.data;
          report.replacedServers.push(name);
        } else {
          report.clashServers.push(name);
        }
        continue;
      }
      registry.servers[name] = parsed.data;
      report.importedServers.push(name);
    }
  }

  const providersFile = resolveSourcePath(config.providersFile ?? "~/.agenthome/providers/providers.yaml", options.cwd);
  let providersBefore: string | null = null;
  let providers: ProvidersConfig = {};
  if (await exists(providersFile)) {
    providersBefore = await fs.readFile(providersFile, "utf8");
    providers = providersSchema.parse(YAML.parse(providersBefore));
  }

  const model = typeof opencodeConfig.model === "string" ? opencodeConfig.model : undefined;
  if (model) {
    const separator = model.indexOf("/");
    if (separator <= 0 || separator >= model.length - 1) {
      report.modelInvalid = model;
    } else {
      const adopted = { provider: model.slice(0, separator), model: model.slice(separator + 1) };
      report.model = model;
      if (!providers.defaults) {
        providers.defaults = adopted;
      } else if (isDeepStrictEqual(providers.defaults, adopted)) {
        report.modelKept = true;
      } else if (options.force) {
        providers.defaults = adopted;
        report.modelReplaced = true;
      } else {
        report.modelClash = true;
      }
    }
  }

  if (Object.keys(registry.servers).length) {
    plan.add(registryFile, registryBefore, YAML.stringify({ servers: registry.servers }));
  }
  if (providers.defaults) {
    plan.add(providersFile, providersBefore, YAML.stringify({ defaults: providers.defaults }));
  }
  return { plan, report };
}

export function renderAdoptionReport(report: AdoptionReport): string {
  const lines: string[] = [`Adoption source: ${report.sources.join(", ")}`];
  if (report.importedServers.length) lines.push(`  mcp adopted: ${report.importedServers.join(", ")}`);
  if (report.keptServers.length) lines.push(`  mcp already in AgentHome: ${report.keptServers.join(", ")}`);
  if (report.replacedServers.length) lines.push(`  mcp replaced (--force): ${report.replacedServers.join(", ")}`);
  if (report.clashServers.length) {
    lines.push(`  mcp clash (AgentHome wins): ${report.clashServers.join(", ")} (use --force to adopt yours)`);
  }
  for (const invalid of report.invalidServers) lines.push(`  mcp invalid (not adopted): ${invalid.name} — ${invalid.reason}`);
  if (report.modelInvalid) {
    lines.push(`  model invalid (not adopted): ${report.modelInvalid} (expected "provider/model")`);
  } else if (report.model) {
    if (report.modelReplaced) lines.push(`  model replaced (--force): ${report.model}`);
    else if (report.modelClash) lines.push(`  model clash (AgentHome wins): ${report.model} (use --force to adopt yours)`);
    else if (report.modelKept) lines.push(`  model already in AgentHome: ${report.model}`);
    else lines.push(`  model adopted: ${report.model}`);
  }
  return lines.join("\n");
}
