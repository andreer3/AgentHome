import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Sandbox {
  root: string;
  home: string;
  project: string;
  cleanup(): Promise<void>;
}

const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

/** Creates an isolated HOME + project under a fresh temp directory. */
export async function createSandbox(): Promise<Sandbox> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agenthome-test-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(project, { recursive: true });
  return {
    root,
    home,
    project,
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

/** Environment with HOME/XDG pointed at the sandbox. Never mutates process.env. */
export function sandboxEnv(sandbox: Sandbox): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: sandbox.home,
    XDG_CONFIG_HOME: path.join(sandbox.home, ".config"),
    XDG_DATA_HOME: path.join(sandbox.home, ".local", "share"),
    XDG_STATE_HOME: path.join(sandbox.home, ".local", "state"),
  };
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the compiled CLI (dist/cli.js) inside the sandbox. */
export function runCli(
  args: string[],
  sandbox: Sandbox,
  options: { cwd?: string } = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: options.cwd ?? sandbox.project,
      env: sandboxEnv(sandbox),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export async function hashFile(file: string): Promise<string | null> {
  try {
    const content = await fs.readFile(file);
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

/** Real (non-sandboxed) OpenCode config paths on this machine. */
export function realOpenCodeFiles(): string[] {
  const configDir = path.join(os.homedir(), ".config", "opencode");
  return [path.join(configDir, "opencode.json"), path.join(configDir, "AGENTS.md")];
}

export async function snapshotFiles(files: string[]): Promise<Record<string, string | null>> {
  const entries = await Promise.all(files.map(async (file) => [file, await hashFile(file)] as const));
  return Object.fromEntries(entries);
}
