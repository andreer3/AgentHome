import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import YAML from "yaml";
import {
  createSandbox,
  hashFile,
  realOpenCodeFiles,
  runCli,
  snapshotFiles,
  type CliResult,
  type Sandbox,
} from "../helpers/sandbox.js";

const RUN_HOOK = fileURLToPath(new URL("./fixtures/run-hook.mjs", import.meta.url));

interface HookEntry {
  path: string;
  aliases: string[];
  last_seen: string;
  harnesses: string[];
  artifacts: { memory: string[]; rules: string[]; skills: string[]; mcp: string[] };
}

/** Fresh sandbox; asserts the real OpenCode config is byte-identical when the test ends. */
async function makeSandbox(t: TestContext): Promise<Sandbox> {
  const realBefore = await snapshotFiles(realOpenCodeFiles());
  const sandbox = await createSandbox();
  t.after(async () => {
    await sandbox.cleanup();
    const realAfter = await snapshotFiles(realOpenCodeFiles());
    assert.deepEqual(realAfter, realBefore, "test touched the real OpenCode configuration");
  });
  return sandbox;
}

function agenthome(sandbox: Sandbox, args: string[]): Promise<CliResult> {
  return runCli([...args, "--home", sandbox.home], sandbox);
}

async function initSandbox(sandbox: Sandbox): Promise<void> {
  const result = await agenthome(sandbox, ["init"]);
  assert.equal(result.code, 0, result.stderr);
}

function hookFile(sandbox: Sandbox, harness: "opencode" | "pi"): string {
  return harness === "opencode"
    ? path.join(sandbox.home, ".config", "opencode", "plugins", "agenthome-register.ts")
    : path.join(sandbox.home, ".pi", "agent", "extensions", "agenthome-register.ts");
}

function indexFile(sandbox: Sandbox): string {
  return path.join(sandbox.home, ".agenthome", "projects.yaml");
}

/** Runs the generated hook through the fixture, with HOME pointed at the sandbox. */
function runHook(sandbox: Sandbox, hook: string, harness: string, project: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUN_HOOK, hook, harness, project], {
      env: { ...process.env, HOME: sandbox.home },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitForEntry(sandbox: Sandbox, harness: string, project: string): Promise<HookEntry> {
  const canonical = await fs.realpath(project);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const doc = YAML.parse(await fs.readFile(indexFile(sandbox), "utf8")) as {
        projects?: Record<string, HookEntry>;
      };
      for (const entry of Object.values(doc?.projects ?? {})) {
        if (entry.path === canonical && entry.harnesses.includes(harness)) return entry;
      }
    } catch {
      // index not written yet
    }
    await sleep(100);
  }
  throw new Error(`hook did not register ${canonical} for ${harness} within 10s`);
}

for (const harness of ["opencode", "pi"] as const) {
  test(`apply ${harness} --scope global writes the managed hook and is idempotent`, async (t) => {
    const sandbox = await makeSandbox(t);
    await initSandbox(sandbox);
    const hook = hookFile(sandbox, harness);

    const first = await agenthome(sandbox, ["apply", harness, "--scope", "global"]);
    assert.equal(first.code, 0, first.stderr);
    const content = await fs.readFile(hook, "utf8");
    assert.match(content, /@agenthome-managed/);
    assert.ok(content.includes(`"--harness", "${harness}"`), `hook must register the ${harness} harness`);

    const before = await hashFile(hook);
    const second = await agenthome(sandbox, ["apply", harness, "--scope", "global"]);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /No changes/);
    assert.equal(await hashFile(hook), before, "second apply must not rewrite the hook");
  });

  test(`apply ${harness} --scope global reports a conflict for an unmanaged hook`, async (t) => {
    const sandbox = await makeSandbox(t);
    await initSandbox(sandbox);
    const hook = hookFile(sandbox, harness);
    await fs.mkdir(path.dirname(hook), { recursive: true });
    await fs.writeFile(hook, "// user extension, not managed\nexport const userThing = 1;\n", "utf8");
    const before = await hashFile(hook);

    const result = await agenthome(sandbox, ["apply", harness, "--scope", "global"]);
    assert.notEqual(result.code, 0, "apply must fail when the hook exists without the marker");
    assert.match(result.stdout + result.stderr, /not managed by AgentHome/);
    assert.equal(await hashFile(hook), before, "unmanaged hook must not be overwritten");
  });

  test(`the generated ${harness} hook registers the project on startup`, async (t) => {
    const sandbox = await makeSandbox(t);
    await initSandbox(sandbox);
    const applied = await agenthome(sandbox, ["apply", harness, "--scope", "global"]);
    assert.equal(applied.code, 0, applied.stderr);

    const project = path.join(sandbox.root, "hooked");
    await fs.mkdir(path.join(project, ".agents", "skills"), { recursive: true });
    await fs.writeFile(path.join(project, "MEMORY.md"), "# Hooked\n", "utf8");
    await fs.writeFile(path.join(project, "AGENTS.md"), "# Rules\n", "utf8");

    const run = await runHook(sandbox, hookFile(sandbox, harness), harness, project);
    assert.equal(run.code, 0, run.stderr || run.stdout);

    const entry = await waitForEntry(sandbox, harness, project);
    assert.equal(entry.path, await fs.realpath(project));
    assert.ok(entry.harnesses.includes(harness));
    assert.deepEqual(entry.artifacts.memory, ["MEMORY.md"]);
    assert.deepEqual(entry.artifacts.rules, ["AGENTS.md"]);
    assert.deepEqual(entry.artifacts.skills, [".agents/skills"]);
    assert.ok(!Number.isNaN(Date.parse(entry.last_seen)));
  });
}
