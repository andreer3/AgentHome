import { loadGlobalConfig, loadProjectConfig, mergeConfig, loadMcpRegistry, loadProviders } from "../config/load.js";
import { resolveSourcePath } from "../core/paths.js";
import { exists } from "../core/files.js";
import { isDeepStrictEqual } from "node:util";

export async function doctorCommand(cwd: string): Promise<void> {
  let errors = 0;
  let warnings = 0;
  const ok = (msg: string) => console.log(`✓ ${msg}`);
  const warn = (msg: string) => { warnings++; console.log(`⚠ ${msg}`); };
  const fail = (msg: string) => { errors++; console.log(`✗ ${msg}`); };

  console.log("AgentHome doctor\n");
  try {
    const { config: global } = await loadGlobalConfig();
    ok("global config valid");
    const { config: project } = await loadProjectConfig(cwd);
    if (project) ok("project config valid"); else warn("project config missing; run agenthome init in this project");
    const config = mergeConfig(global, project);

    for (const [scope, group] of Object.entries(config.sources)) {
      for (const kind of ["memory", "rules", "skills"] as const) {
        for (const source of group[kind]) {
          const file = resolveSourcePath(source, cwd);
          (await exists(file)) ? ok(`${scope}.${kind}: ${source}`) : warn(`${scope}.${kind} missing: ${source}`);
        }
      }
    }

    const mcpGlobal = await loadMcpRegistry(global, cwd);
    ok(`MCP global registry valid (${Object.keys(mcpGlobal.servers).length} servers)`);
    const mcpProject = project ? await loadMcpRegistry(project, cwd) : { servers: {} };
    if (project) ok(`MCP project registry valid (${Object.keys(mcpProject.servers).length} servers)`);
    for (const [name, server] of Object.entries(mcpGlobal.servers)) {
      const projectServer = mcpProject.servers[name];
      if (projectServer && !isDeepStrictEqual(server, projectServer)) {
        warn(`MCP '${name}' is defined in both scopes with different content; the project entry wins`);
      }
    }
    for (const [name, server] of Object.entries({ ...mcpGlobal.servers, ...mcpProject.servers })) {
      if (server.enabled === false && (!server.targets || server.targets.includes("pi"))) {
        warn(`MCP '${name}' is disabled and will be skipped for pi (pi-mcp-extension has no 'enabled' field)`);
      }
    }

    const providers = await loadProviders(config, cwd);
    if (providers.defaults) ok(`portable model default: ${providers.defaults.provider}/${providers.defaults.model}`);
    else ok("no portable model default configured");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  console.log(`\nResult: ${errors} error(s), ${warnings} warning(s)`);
  if (errors) process.exitCode = 1;
}
