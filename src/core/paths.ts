import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function resolveSourcePath(input: string, cwd: string): string {
  const expanded = expandHome(input);
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

export function globalRoot(): string {
  return path.join(os.homedir(), ".agenthome");
}

/** Absolute path to the compiled AgentHome CLI (dist/cli.js), used by harness hooks. */
export function resolveCliPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "..", "cli.js"),
    path.resolve(here, "..", "..", "dist", "cli.js"),
  ];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return candidates[0];
}
