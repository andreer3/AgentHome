import fs from "node:fs/promises";
import path from "node:path";

export async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function writeIfMissing(file: string, content: string): Promise<boolean> {
  if (await exists(file)) return false;
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, content, "utf8");
  return true;
}

export async function readText(file: string): Promise<string> {
  return fs.readFile(file, "utf8");
}

export async function commandExists(command: string): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}
