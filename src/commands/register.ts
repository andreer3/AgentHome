import { exists } from "../core/files.js";
import { registerProject } from "../core/projects.js";

export interface RegisterOptions {
  path?: string;
  harness?: string;
  verbose?: boolean;
}

/**
 * Registers a project in AgentHome's index. Called by the harness hooks, so it
 * must stay silent, cheap and safe: never fail the harness startup.
 */
export async function registerCommand(options: RegisterOptions): Promise<void> {
  const projectPath = options.path ?? process.cwd();
  if (!(await exists(projectPath))) return;
  const { slug, entry } = await registerProject(projectPath, options.harness ?? "unknown");
  if (options.verbose) {
    console.log(`${slug} -> ${entry.path}`);
    console.log(`  harnesses: ${entry.harnesses.join(", ") || "-"}`);
    console.log(`  memory: ${entry.artifacts.memory.join(", ") || "-"}`);
    console.log(`  rules: ${entry.artifacts.rules.join(", ") || "-"}`);
    console.log(`  skills: ${entry.artifacts.skills.join(", ") || "-"}`);
  }
}
