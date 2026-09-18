import { absoluteArtifacts, loadIndex, requireProject } from "../core/projects.js";

export interface RouteOptions {
  json?: boolean;
}

/**
 * Resolves a project keyword to the absolute paths of its memory/rules/skills/mcp
 * artifacts. It returns paths only: the caller (the AI model) reads them on demand.
 */
export async function routeCommand(query: string, options: RouteOptions): Promise<void> {
  const index = await loadIndex();
  const { slug, entry } = requireProject(index, query);
  const artifacts = absoluteArtifacts(entry);

  if (options.json) {
    console.log(JSON.stringify({
      slug,
      path: entry.path,
      aliases: entry.aliases,
      harnesses: entry.harnesses,
      last_seen: entry.last_seen,
      artifacts,
    }, null, 2));
    return;
  }

  console.log(`project: ${slug}`);
  console.log(`path: ${entry.path}`);
  if (entry.aliases.length) console.log(`aliases: ${entry.aliases.join(", ")}`);
  for (const [kind, values] of Object.entries(artifacts)) {
    console.log(`${kind}:`);
    if (!values.length) console.log("  -");
    for (const value of values) console.log(`  ${value}`);
  }
  console.log("Note: read these paths on demand; do not copy their contents into global memory.");
}
