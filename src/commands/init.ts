import path from "node:path";
import { ensureDir, exists, readText, writeIfMissing } from "../core/files.js";
import { globalRoot, resolveCliPath } from "../core/paths.js";
import { loadGlobalConfig } from "../config/load.js";
import { planAdoption, renderAdoptionReport } from "../core/adopt.js";
import { MANAGED_MARKER } from "../adapters/opencode-slots.js";

const GLOBAL_RULES = `# Global rules

Keep durable cross-project operating rules here.

## Cross-project memory and skills

Other projects keep their own memory and skills. When a task refers to another project, resolve it with AgentHome's router before reading anything:

- use the \`agenthome-route\` tool (OpenCode) or \`agenthome_route\` (Pi) if available;
- otherwise run \`agenthome route <project> --json\` (or \`node "${resolveCliPath()}" route <project> --json\`).

Read the returned paths on demand. Do not guess paths by exploring, and never copy another project's contents into this file.
`;

const GLOBAL_CONFIG = `version: 1
sources:
  global:
    memory:
      - ~/.agenthome/memory/global.md
    rules:
      - ~/.agenthome/rules/global.md
    skills:
      - ~/.agents/skills
  project:
    memory: []
    rules: []
    skills: []
mcpRegistry: ~/.agenthome/mcp/registry.yaml
providersFile: ~/.agenthome/providers/providers.yaml
targets:
  - opencode
  - pi
`;

const PROJECT_CONFIG = `version: 1
sources:
  global:
    memory: []
    rules: []
    skills: []
  project:
    memory:
      - ./.agenthome/memory.md
    rules:
      - ./.agenthome/rules.md
    skills:
      - ./.agents/skills
mcpRegistry: ./.agenthome/mcp.yaml
providersFile: ~/.agenthome/providers/providers.yaml
targets:
  - opencode
  - pi
`;

async function isManaged(file: string): Promise<boolean> {
  if (!(await exists(file))) return false;
  return (await readText(file)).includes(MANAGED_MARKER);
}

export interface InitOptions {
  scope: "global" | "project" | "all";
}

export async function initCommand(cwd: string, options: InitOptions = { scope: "all" }): Promise<void> {
  const root = globalRoot();
  const doGlobal = options.scope === "global" || options.scope === "all";
  const doProject = options.scope === "project" || options.scope === "all";

  const dirs: string[] = [];
  if (doGlobal) {
    dirs.push(
      path.join(root, "memory"),
      path.join(root, "rules"),
      path.join(root, "mcp"),
      path.join(root, "providers"),
      path.join(process.env.HOME ?? root, ".agents", "skills"),
    );
  }
  if (doProject) {
    dirs.push(path.join(cwd, ".agenthome"), path.join(cwd, ".agents", "skills"));
  }
  await Promise.all(dirs.map((dir) => ensureDir(dir)));

  const files: Array<[string, string]> = [];
  if (doGlobal) {
    files.push(
      [path.join(root, "agenthome.yaml"), GLOBAL_CONFIG],
      [path.join(root, "memory", "global.md"), "# Global memory\n\nKeep durable facts that should be available across projects here.\n"],
      [path.join(root, "rules", "global.md"), GLOBAL_RULES],
      [path.join(root, "mcp", "registry.yaml"), "servers: {}\n"],
      [path.join(root, "providers", "providers.yaml"), "# Optional portable default model\n# defaults:\n#   provider: deepseek\n#   model: deepseek-chat\n{}\n"],
    );
  }
  if (doProject) {
    files.push(
      [path.join(cwd, ".agenthome.yaml"), PROJECT_CONFIG],
      [path.join(cwd, ".agenthome", "memory.md"), "# Project memory\n\nCurrent durable project knowledge.\n"],
      [path.join(cwd, ".agenthome", "rules.md"), "# Project rules\n\nProject-specific operating rules.\n"],
      [path.join(cwd, ".agenthome", "mcp.yaml"), "servers: {}\n"],
    );
  }

  const created: string[] = [];
  for (const [file, content] of files) if (await writeIfMissing(file, content)) created.push(file);

  console.log("AgentHome initialized.");
  for (const file of created) console.log(`  + ${file}`);
  if (!created.length) console.log("  No files changed; existing configuration was preserved.");

  if (doGlobal) {
    // First-installation adoption: bring the existing OpenCode config into AgentHome's
    // canonical files BEFORE AgentHome starts taking precedence over the user's config.
    try {
      const { config } = await loadGlobalConfig();
      const { plan, report } = await planAdoption(config, { scope: "global", cwd, force: false });
      if (report.sources.length) {
        console.log("\nFirst-installation adoption:");
        console.log(renderAdoptionReport(report));
        const changed = await plan.commit();
        for (const file of changed) console.log(`  ~ ${file}`);
        if (!changed.length) console.log("  No changes.");
      }
    } catch (error) {
      console.warn(`Warning: could not adopt existing OpenCode configuration: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (doProject) {
    const projectConfigs = [path.join(cwd, "opencode.json"), path.join(cwd, "opencode.jsonc")];
    const inherited: string[] = [];
    for (const file of projectConfigs) {
      if ((await exists(file)) && !(await isManaged(file))) inherited.push(file);
    }
    if (inherited.length) {
      console.log(`\nNote: project OpenCode config found (${inherited.join(", ")}); it stays yours and OpenCode inherits it.`);
    }
  }
}
