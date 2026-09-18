import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { configSchema, DEFAULT_TARGETS, mcpRegistrySchema, providersSchema, type AgentHomeConfig, type McpRegistry, type ProvidersConfig, type ResolvedConfig } from "./schema.js";
import { exists } from "../core/files.js";
import { globalRoot, resolveSourcePath } from "../core/paths.js";

async function parseYaml(file: string): Promise<unknown> {
  return YAML.parse(await fs.readFile(file, "utf8"));
}

export async function loadGlobalConfig(): Promise<{ config: AgentHomeConfig; file: string }> {
  const file = path.join(globalRoot(), "agenthome.yaml");
  if (!(await exists(file))) throw new Error(`Global config not found: ${file}. Run agenthome init.`);
  return { config: configSchema.parse(await parseYaml(file)), file };
}

export async function loadProjectConfig(cwd: string): Promise<{ config: AgentHomeConfig | null; file: string }> {
  const file = path.join(cwd, ".agenthome.yaml");
  if (!(await exists(file))) return { config: null, file };
  return { config: configSchema.parse(await parseYaml(file)), file };
}

export function mergeConfig(globalConfig: AgentHomeConfig, projectConfig: AgentHomeConfig | null): ResolvedConfig {
  if (!projectConfig) {
    return { ...globalConfig, targets: globalConfig.targets ?? [...DEFAULT_TARGETS] };
  }
  return {
    version: 1,
    sources: {
      global: globalConfig.sources.global,
      project: projectConfig.sources.project,
    },
    mcpRegistry: projectConfig.mcpRegistry ?? globalConfig.mcpRegistry,
    providersFile: projectConfig.providersFile ?? globalConfig.providersFile,
    targets: projectConfig.targets ?? globalConfig.targets ?? [...DEFAULT_TARGETS],
  };
}

export async function loadMcpRegistry(config: AgentHomeConfig, cwd: string): Promise<McpRegistry> {
  if (!config.mcpRegistry) return { servers: {} };
  const file = resolveSourcePath(config.mcpRegistry, cwd);
  if (!(await exists(file))) return { servers: {} };
  return mcpRegistrySchema.parse(await parseYaml(file));
}

export async function loadProviders(config: AgentHomeConfig, cwd: string): Promise<ProvidersConfig> {
  if (!config.providersFile) return {};
  const file = resolveSourcePath(config.providersFile, cwd);
  if (!(await exists(file))) return {};
  return providersSchema.parse(await parseYaml(file));
}
