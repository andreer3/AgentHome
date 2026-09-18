import { hasArtifacts, loadIndex } from "../core/projects.js";

export interface SummaryOptions {
  json?: boolean;
}

export async function summaryCommand(options: SummaryOptions): Promise<void> {
  const index = await loadIndex();
  const entries = Object.entries(index.projects);
  const withArtifacts = entries.filter(([, entry]) => hasArtifacts(entry));
  const withMemory = entries.filter(([, entry]) => entry.artifacts.memory.length).length;
  const withSkills = entries.filter(([, entry]) => entry.artifacts.skills.length).length;
  const recentlyChanged = withArtifacts
    .slice()
    .sort((a, b) => (b[1].artifacts_changed_at ?? "").localeCompare(a[1].artifacts_changed_at ?? ""))
    .slice(0, 5);

  if (options.json) {
    console.log(JSON.stringify({
      projects: entries.length,
      withArtifacts: withArtifacts.length,
      withMemory,
      withSkills,
      recentlyChanged: recentlyChanged.map(([slug, entry]) => ({
        slug,
        artifacts_changed_at: entry.artifacts_changed_at,
      })),
    }, null, 2));
    return;
  }

  console.log(
    `AgentHome projects: ${entries.length} (${withArtifacts.length} with memory/rules/skills, ${entries.length - withArtifacts.length} without)`,
  );
  console.log(`  with memory: ${withMemory}`);
  console.log(`  with skills: ${withSkills}`);
  if (recentlyChanged.length) {
    console.log("  recently changed:");
    for (const [slug, entry] of recentlyChanged) {
      console.log(`    ${slug} (${entry.artifacts_changed_at ? entry.artifacts_changed_at.slice(0, 10) : "-"})`);
    }
  }
}
