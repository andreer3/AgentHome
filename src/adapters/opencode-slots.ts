import { exists, readText } from "../core/files.js";
import { MANAGED_MARKER } from "../core/managed.js";

export { MANAGED_HEADER, MANAGED_MARKER } from "../core/managed.js";

export interface ConfigSlot {
  file: string;
  owned: boolean;
}

/**
 * AgentHome must own the highest-precedence OpenCode config file so that its
 * values win when OpenCode deep-merges configs. This resolves that file:
 * 1. if it does not exist, AgentHome creates it;
 * 2. if it exists with the AgentHome marker, AgentHome updates it;
 * 3. if it exists and belongs to the user, it fails with migration guidance
 *    (adopt it with `agenthome import opencode`, then rename or remove it).
 */
export async function resolveConfigSlot(file: string): Promise<ConfigSlot> {
  if (!(await exists(file))) return { file, owned: true };
  const text = await readText(file);
  if (text.includes(MANAGED_MARKER)) return { file, owned: true };
  throw new Error(
    `${file} already exists and is not managed by AgentHome. AgentHome must own this file to take precedence. ` +
      "Run 'agenthome import opencode' to adopt its contents, then rename it to opencode.json (or remove it).",
  );
}
