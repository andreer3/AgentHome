import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { ensureDir, exists } from "./files.js";
import { globalRoot } from "./paths.js";

const artifactsSchema = z.object({
  memory: z.array(z.string()).default([]),
  rules: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  mcp: z.array(z.string()).default([]),
});

const projectEntrySchema = z.object({
  path: z.string(),
  aliases: z.array(z.string()).default([]),
  last_seen: z.string().default(""),
  /** When memory/rules/skills/mcp actually changed (not just when a harness started). */
  artifacts_changed_at: z.string().default(""),
  /** Signature of the detected artifacts; used to detect real changes. */
  artifacts_signature: z.string().default(""),
  harnesses: z.array(z.string()).default([]),
  artifacts: artifactsSchema.default({ memory: [], rules: [], skills: [], mcp: [] }),
});

const projectsIndexSchema = z.object({
  projects: z.record(z.string(), projectEntrySchema).default({}),
});

export type ProjectArtifacts = z.infer<typeof artifactsSchema>;
export type ProjectEntry = z.infer<typeof projectEntrySchema>;
export type ProjectsIndex = z.infer<typeof projectsIndexSchema>;

/** Project-local artifacts AgentHome tracks (paths only, never contents). */
export const ARTIFACT_CANDIDATES: Record<keyof ProjectArtifacts, string[]> = {
  memory: [".agenthome/memory.md", "MEMORY.md"],
  rules: ["AGENTS.md", ".agenthome/rules.md"],
  skills: [".agents/skills", ".opencode/skills", ".pi/skills", ".claude/skills"],
  mcp: [".agenthome/mcp.yaml", "opencode.jsonc", "opencode.json", ".pi/mcp.json"],
};

export function indexFile(): string {
  return path.join(globalRoot(), "projects.yaml");
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

export async function loadIndex(): Promise<ProjectsIndex> {
  const file = indexFile();
  if (!(await exists(file))) return { projects: {} };
  const parsed: unknown = YAML.parse(await fs.readFile(file, "utf8"));
  return projectsIndexSchema.parse(parsed ?? {});
}

export async function saveIndex(index: ProjectsIndex): Promise<void> {
  const file = indexFile();
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, YAML.stringify({ projects: index.projects }), "utf8");
  await fs.rename(tmp, file);
}

export async function detectArtifacts(projectPath: string): Promise<ProjectArtifacts> {
  const result: ProjectArtifacts = { memory: [], rules: [], skills: [], mcp: [] };
  for (const [kind, candidates] of Object.entries(ARTIFACT_CANDIDATES) as [keyof ProjectArtifacts, string[]][]) {
    for (const candidate of candidates) {
      if (await exists(path.join(projectPath, candidate))) result[kind].push(candidate);
    }
  }
  return result;
}

async function canonicalPath(projectPath: string): Promise<string> {
  const resolved = path.resolve(projectPath);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

function assignSlug(index: ProjectsIndex, projectPath: string): string {
  for (const [slug, entry] of Object.entries(index.projects)) {
    if (entry.path === projectPath) return slug;
  }
  const base = slugify(path.basename(projectPath));
  let slug = base;
  let counter = 2;
  while (index.projects[slug]) {
    slug = `${base}-${counter}`;
    counter += 1;
  }
  return slug;
}

export async function registerProject(projectPath: string, harness: string): Promise<{ slug: string; entry: ProjectEntry }> {
  const resolved = await canonicalPath(projectPath);
  const index = await loadIndex();
  const slug = assignSlug(index, resolved);
  const previous = index.projects[slug];
  const artifacts = await detectArtifacts(resolved);
  const signature = JSON.stringify(artifacts);
  const now = new Date().toISOString();

  let artifactsChangedAt = now;
  if (previous) {
    if (!previous.artifacts_signature) {
      // Legacy entry without a signature: don't report a false change.
      artifactsChangedAt = previous.last_seen || now;
    } else if (previous.artifacts_signature === signature) {
      artifactsChangedAt = previous.artifacts_changed_at || previous.last_seen || now;
    }
  }

  const entry: ProjectEntry = {
    path: resolved,
    aliases: previous?.aliases ?? [],
    last_seen: now,
    artifacts_changed_at: artifactsChangedAt,
    artifacts_signature: signature,
    harnesses: Array.from(new Set([...(previous?.harnesses ?? []), harness])),
    artifacts,
  };
  index.projects[slug] = entry;
  await saveIndex(index);
  return { slug, entry };
}

export function hasArtifacts(entry: ProjectEntry): boolean {
  return Object.values(entry.artifacts).some((paths) => paths.length > 0);
}

export type ResolveResult =
  | { kind: "match"; slug: string; entry: ProjectEntry }
  | { kind: "ambiguous"; slugs: string[] }
  | { kind: "none" };

export function resolveProject(index: ProjectsIndex, query: string): ResolveResult {
  const trimmed = query.trim();
  if (!trimmed) return { kind: "none" };
  const lower = trimmed.toLowerCase();
  const matches = new Map<string, ProjectEntry>();
  const add = (slug: string, entry: ProjectEntry) => { if (!matches.has(slug)) matches.set(slug, entry); };

  const exact = index.projects[trimmed];
  if (exact) add(trimmed, exact);

  for (const [slug, entry] of Object.entries(index.projects)) {
    const aliases = entry.aliases.map((alias) => alias.toLowerCase());
    const basename = path.basename(entry.path).toLowerCase();
    const pathMatches = entry.path === trimmed || entry.path.endsWith(`/${trimmed}`);
    const fuzzy = aliases.includes(lower) || basename === lower || slug === lower ||
      aliases.some((alias) => alias.includes(lower)) || basename.includes(lower) || slug.includes(lower);
    if (pathMatches || fuzzy) add(slug, entry);
  }

  if (matches.size === 1) {
    const [slug, entry] = [...matches.entries()][0];
    return { kind: "match", slug, entry };
  }
  if (matches.size > 1) return { kind: "ambiguous", slugs: [...matches.keys()] };
  return { kind: "none" };
}

export function absoluteArtifacts(entry: ProjectEntry): ProjectArtifacts {
  const result: ProjectArtifacts = { memory: [], rules: [], skills: [], mcp: [] };
  for (const kind of Object.keys(result) as (keyof ProjectArtifacts)[]) {
    result[kind] = entry.artifacts[kind].map((relative) => path.join(entry.path, relative));
  }
  return result;
}

export function requireProject(index: ProjectsIndex, query: string): { slug: string; entry: ProjectEntry } {
  const result = resolveProject(index, query);
  if (result.kind === "none") throw new Error(`No project matches '${query}'.`);
  if (result.kind === "ambiguous") {
    throw new Error(`'${query}' matches several projects: ${result.slugs.join(", ")}. Run 'agenthome projects list'.`);
  }
  return { slug: result.slug, entry: result.entry };
}
