import { loadGlobalConfig, loadProjectConfig } from "../config/load.js";
import { planAdoption, renderAdoptionReport } from "../core/adopt.js";
import { renderPlan } from "../core/plan.js";

export interface ImportOptions {
  scope: "global" | "project";
  dryRun: boolean;
  force: boolean;
}

export async function importCommand(target: string, cwd: string, options: ImportOptions): Promise<void> {
  if (target !== "opencode") throw new Error("import currently supports only 'opencode'");
  const { config: globalConfig } = await loadGlobalConfig();
  const { config: projectConfig } = await loadProjectConfig(cwd);
  const config = options.scope === "project" ? projectConfig : globalConfig;
  if (!config) throw new Error("Project config not found; run 'agenthome init' in this project first.");
  const { plan, report } = await planAdoption(config, { scope: options.scope, cwd, force: options.force });
  if (!report.sources.length) {
    console.log(`No ${options.scope} OpenCode config found to import.`);
    return;
  }
  console.log(renderAdoptionReport(report));
  if (options.dryRun) {
    console.log(renderPlan(plan));
    return;
  }
  const changed = await plan.commit();
  for (const file of changed) console.log(`  ~ ${file}`);
  if (!changed.length) console.log("  No changes.");
}
