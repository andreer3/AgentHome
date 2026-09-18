import { hasArtifacts, loadIndex, requireProject, saveIndex, type ProjectEntry } from "../core/projects.js";

export interface ProjectsOptions {
  json?: boolean;
  /** Include projects without memory/skills (hidden by default). */
  all?: boolean;
}

function formatEntry(slug: string, entry: ProjectEntry): string {
  const tags: string[] = [];
  if (entry.artifacts.memory.length) tags.push(`memory:${entry.artifacts.memory.length}`);
  if (entry.artifacts.rules.length) tags.push(`rules:${entry.artifacts.rules.length}`);
  if (entry.artifacts.skills.length) tags.push(`skills:${entry.artifacts.skills.length}`);
  if (entry.artifacts.mcp.length) tags.push(`mcp:${entry.artifacts.mcp.length}`);
  const harnesses = entry.harnesses.join(",") || "-";
  const seen = entry.last_seen ? entry.last_seen.slice(0, 10) : "-";
  const changed = entry.artifacts_changed_at ? entry.artifacts_changed_at.slice(0, 10) : "-";
  if (!hasArtifacts(entry)) tags.push("no-artifacts");
  return `${slug}\t${entry.path}\t[${harnesses}] ${tags.join(" ") || "-"} seen:${seen} changed:${changed}`;
}

function byChange(entry: ProjectEntry): string {
  return hasArtifacts(entry) ? entry.artifacts_changed_at : entry.last_seen;
}

export async function projectsListCommand(options: ProjectsOptions): Promise<void> {
  const index = await loadIndex();
  const allEntries = Object.entries(index.projects);
  const entries = (options.all ? allEntries : allEntries.filter(([, entry]) => hasArtifacts(entry)))
    .sort((a, b) => byChange(b[1]).localeCompare(byChange(a[1])));
  if (options.json) {
    console.log(JSON.stringify({ projects: Object.fromEntries(entries) }, null, 2));
    return;
  }
  if (!entries.length) {
    console.log(
      options.all
        ? "No projects indexed yet. They are registered when OpenCode or Pi starts in a project."
        : "No projects with memory/rules/skills indexed yet. Use --all to list every registered project.",
    );
    return;
  }
  for (const [slug, entry] of entries) console.log(formatEntry(slug, entry));
}

export async function projectsShowCommand(query: string, options: ProjectsOptions): Promise<void> {
  const index = await loadIndex();
  const { slug, entry } = requireProject(index, query);
  if (options.json) {
    console.log(JSON.stringify({ slug, ...entry }, null, 2));
    return;
  }
  console.log(slug);
  console.log(`  path: ${entry.path}`);
  console.log(`  aliases: ${entry.aliases.join(", ") || "-"}`);
  console.log(`  harnesses: ${entry.harnesses.join(", ") || "-"}`);
  console.log(`  last seen: ${entry.last_seen || "-"}`);
  for (const [kind, values] of Object.entries(entry.artifacts)) {
    console.log(`  ${kind}: ${values.length ? values.join(", ") : "-"}`);
  }
}

export async function projectsAliasCommand(query: string, aliases: string[]): Promise<void> {
  const index = await loadIndex();
  const { slug, entry } = requireProject(index, query);
  entry.aliases = Array.from(new Set([...entry.aliases, ...aliases.map((alias) => alias.trim()).filter(Boolean)]));
  index.projects[slug] = entry;
  await saveIndex(index);
  console.log(`${slug}: aliases = ${entry.aliases.join(", ")}`);
}

export async function projectsRemoveCommand(query: string): Promise<void> {
  const index = await loadIndex();
  const { slug } = requireProject(index, query);
  delete index.projects[slug];
  await saveIndex(index);
  console.log(`Removed '${slug}' from the index (project files were not touched).`);
}
