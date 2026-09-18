import { adapters } from "../adapters/index.js";
import { loadGlobalConfig, loadProjectConfig, mergeConfig, loadMcpRegistry, loadProviders } from "../config/load.js";
import { ApplyPlan, renderPlan } from "../core/plan.js";
import type { ApplyScope } from "../adapters/types.js";

export interface ApplyOptions {
  scope: ApplyScope;
  dryRun: boolean;
  force: boolean;
}

export async function applyCommand(target: "opencode" | "pi", cwd: string, options: ApplyOptions): Promise<void> {
  const { config: globalConfig } = await loadGlobalConfig();
  const { config: projectConfig } = await loadProjectConfig(cwd);
  const config = mergeConfig(globalConfig, projectConfig);
  if (!config.targets.includes(target)) throw new Error(`Target '${target}' is disabled in AgentHome config`);
  const mcpGlobal = await loadMcpRegistry(globalConfig, cwd);
  const mcpProject = projectConfig ? await loadMcpRegistry(projectConfig, cwd) : { servers: {} };
  const providers = await loadProviders(config, cwd);

  const plan = new ApplyPlan();
  await adapters[target].plan({
    cwd,
    config,
    mcpGlobal,
    mcpProject,
    providers,
    scope: options.scope,
    plan,
    force: options.force,
  });

  if (options.dryRun) {
    console.log(renderPlan(plan));
    if (plan.hasConflicts()) process.exitCode = 1;
    return;
  }

  const changed = await plan.commit();
  console.log(`Applied AgentHome to ${target} (${options.scope}).`);
  for (const file of changed) console.log(`  ~ ${file}`);
  if (!changed.length) console.log("  No changes; generated configuration was already up to date.");
  if (plan.hasConflicts()) {
    console.log(`\nSkipped ${plan.conflicts.length} conflicting key(s); use --force to replace:`);
    for (const conflict of plan.conflicts) console.log(`  ! ${conflict.file}: ${conflict.detail}`);
    process.exitCode = 1;
  }
  const piServers = Object.keys({ ...mcpGlobal.servers, ...mcpProject.servers }).length;
  if (target === "pi" && piServers) {
    console.log("\nPi MCP: install/enable pi-mcp-extension before expecting .pi/mcp.json servers to load.");
  }
}
