import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { applyEdits, modify, parse } from "jsonc-parser";
import { ensureDir, exists, readText } from "./files.js";
import { MANAGED_MARKER } from "./managed.js";

export interface PlannedFile {
  file: string;
  before: string | null;
  after: string;
  kind: "create" | "update";
}

export interface PlanConflict {
  file: string;
  key: string;
  detail: string;
}

export class ApplyPlan {
  readonly conflicts: PlanConflict[] = [];
  private readonly files = new Map<string, PlannedFile>();

  add(file: string, before: string | null, after: string): void {
    const previous = this.files.get(file);
    if (previous) {
      previous.after = after;
      return;
    }
    this.files.set(file, { file, before, after, kind: before === null ? "create" : "update" });
  }

  get changes(): PlannedFile[] {
    return [...this.files.values()].filter((change) => change.before !== change.after);
  }

  hasConflicts(): boolean {
    return this.conflicts.length > 0;
  }

  async commit(): Promise<string[]> {
    const changed: string[] = [];
    for (const change of this.changes) {
      await ensureDir(path.dirname(change.file));
      await fs.writeFile(change.file, change.after, "utf8");
      changed.push(change.file);
    }
    return changed;
  }
}

export function renderPlan(plan: ApplyPlan): string {
  const lines: string[] = [];
  const changes = plan.changes;
  if (changes.length) {
    lines.push("Planned changes:");
    for (const change of changes) {
      lines.push(`  ${change.kind === "create" ? "+" : "~"} ${change.file}`);
    }
  } else {
    lines.push("No changes.");
  }
  if (plan.conflicts.length) {
    lines.push("", "Conflicts (not applied):");
    for (const conflict of plan.conflicts) {
      lines.push(`  ! ${conflict.file}: ${conflict.detail}`);
    }
  }
  return lines.join("\n");
}

export function buildManagedBlock(current: string, blockId: string, body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return current;
  const start = `<!-- agenthome:${blockId}:start -->`;
  const end = `<!-- agenthome:${blockId}:end -->`;
  const block = `${start}\n${trimmed}\n${end}`;

  const startIndex = current.indexOf(start);
  const endIndex = current.indexOf(end);
  const hasCompleteBlock = startIndex >= 0 && endIndex > startIndex;
  if (hasCompleteBlock) {
    const before = current.slice(0, startIndex);
    const after = current.slice(endIndex + end.length);
    // Fast path: exactly one complete block and no stray markers around it.
    if (!before.includes(start) && !before.includes(end) && !after.includes(start) && !after.includes(end)) {
      return `${before}${block}${after}`;
    }
  }

  // Anomalous input (orphan markers or duplicate blocks): drop every block and
  // marker, then append a single canonical block at the end.
  let text = current;
  for (;;) {
    const s = text.indexOf(start);
    const e = text.indexOf(end);
    if (s >= 0 && e > s) {
      text = text.slice(0, s) + text.slice(e + end.length);
      continue;
    }
    break;
  }
  text = text.split(start).join("").split(end).join("");
  const cleaned = text.replace(/\n{3,}/g, "\n\n").trim();
  return cleaned.length ? `${cleaned}\n\n${block}\n` : `${block}\n`;
}

export interface JsoncBuildResult {
  content: string;
  conflicts: PlanConflict[];
}

export function buildJsoncProperties(
  current: string,
  file: string,
  properties: Record<string, unknown>,
  options: { force: boolean; owned?: boolean; header?: string },
): JsoncBuildResult {
  const isNew = !current.trim().length;
  let text = isNew ? "{}\n" : current;
  const errors: { error: number; offset: number; length: number }[] = [];
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error(`Cannot safely edit invalid JSON/JSONC: ${file}`);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Cannot safely edit JSON/JSONC that is not an object: ${file}`);
  }

  const conflicts: PlanConflict[] = [];
  for (const [key, value] of Object.entries(properties)) {
    const hasKey = Object.prototype.hasOwnProperty.call(parsed, key);
    if (hasKey && !options.force && !options.owned && !isDeepStrictEqual((parsed as Record<string, unknown>)[key], value)) {
      conflicts.push({
        file,
        key,
        detail: `'${key}' already exists with a different value (use --force to replace it)`,
      });
      continue;
    }
    const edits = modify(text, [key], value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    });
    text = applyEdits(text, edits);
  }
  if (!text.endsWith("\n")) text += "\n";
  if (options.header && isNew) text = `${options.header}\n${text}`;
  return { content: text, conflicts };
}

export async function planManagedBlock(
  plan: ApplyPlan,
  file: string,
  blockId: string,
  body: string,
): Promise<void> {
  if (!body.trim()) return;
  const before = (await exists(file)) ? await readText(file) : null;
  const after = buildManagedBlock(before ?? "", blockId, body);
  if (after === (before ?? "")) return;
  plan.add(file, before, after);
}

export async function planJsoncProperties(
  plan: ApplyPlan,
  file: string,
  properties: Record<string, unknown>,
  options: { force: boolean; owned?: boolean; header?: string },
): Promise<void> {
  if (!Object.keys(properties).length) return;
  const before = (await exists(file)) ? await readText(file) : null;
  const { content, conflicts } = buildJsoncProperties(before ?? "", file, properties, options);
  plan.conflicts.push(...conflicts);
  // Conflicting keys are skipped inside the builder; non-conflicting ones are still planned.
  plan.add(file, before, content);
}

/**
 * Plans a plain-text file that AgentHome owns (harness hooks, generated docs).
 * Fails the plan if the file exists without the AgentHome marker.
 */
export async function planOwnedFile(plan: ApplyPlan, file: string, content: string): Promise<void> {
  const before = (await exists(file)) ? await readText(file) : null;
  if (before !== null && !before.includes(MANAGED_MARKER)) {
    plan.conflicts.push({
      file,
      key: "file",
      detail: "file exists and is not managed by AgentHome (move it or remove it)",
    });
    return;
  }
  plan.add(file, before, content);
}
