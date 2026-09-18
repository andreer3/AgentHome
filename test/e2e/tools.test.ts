import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import {
  createSandbox,
  hashFile,
  realOpenCodeFiles,
  runCli,
  snapshotFiles,
  type CliResult,
  type Sandbox,
} from "../helpers/sandbox.js";

const CALL_TOOL = fileURLToPath(new URL("./fixtures/call-tool.mjs", import.meta.url));

interface RouteResult {
  slug: string;
  path: string;
  aliases: string[];
  harnesses: string[];
  last_seen: string;
  artifacts: { memory: string[]; rules: string[]; skills: string[]; mcp: string[] };
}

interface OpenCodeToolModule {
  default: { execute(args: { query: string }, context: Record<string, unknown>): Promise<unknown> };
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

function routeToolFile(sandbox: Sandbox, harness: "opencode" | "pi"): string {
  return harness === "opencode"
    ? path.join(sandbox.home, ".config", "opencode", "tool", "agenthome-route.ts")
    : path.join(sandbox.home, ".pi", "agent", "extensions", "agenthome-route.ts");
}

/** Creates a project with MEMORY.md and indexes it so `route` resolves it. */
async function indexProject(sandbox: Sandbox, name: string): Promise<string> {
  const project = path.join(sandbox.root, name);
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, "MEMORY.md"), `# ${name}\n`, "utf8");
  const result = await agenthome(sandbox, ["register", "--path", project, "--harness", "opencode"]);
  assert.equal(result.code, 0, result.stderr);
  return project;
}

/** Drives the generated Pi extension through call-tool.mjs with HOME pointed at the sandbox. */
function runPiTool(sandbox: Sandbox, tool: string, query: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CALL_TOOL, tool, query], {
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

/**
 * Creates the @opencode-ai/plugin stub the generated OpenCode tool imports:
 * `tool(def)` returns the definition and `tool.schema` mimics the Zod helpers.
 */
async function writePluginStub(sandbox: Sandbox): Promise<void> {
  const dir = path.join(sandbox.home, ".config", "opencode", "node_modules", "@opencode-ai", "plugin");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "@opencode-ai/plugin", type: "module", main: "index.js" }, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "index.js"),
    'export const tool = (def) => def;\ntool.schema = { string: () => ({ describe: () => ({ type: "string" }) }) };\n',
    "utf8",
  );
}

/** Imports the generated OpenCode tool in-process with HOME pointed at the sandbox. */
async function runOpenCodeTool(sandbox: Sandbox, tool: string, query: string): Promise<unknown> {
  const previousHome = process.env.HOME;
  process.env.HOME = sandbox.home;
  try {
    const mod = (await import(pathToFileURL(tool).href)) as OpenCodeToolModule;
    return await mod.default.execute({ query }, {});
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
}

for (const harness of ["opencode", "pi"] as const) {
  test(`apply ${harness} --scope global writes the managed route tool and is idempotent`, async (t) => {
    const sandbox = await makeSandbox(t);
    await initSandbox(sandbox);
    const tool = routeToolFile(sandbox, harness);

    const first = await agenthome(sandbox, ["apply", harness, "--scope", "global"]);
    assert.equal(first.code, 0, first.stderr);
    const content = await fs.readFile(tool, "utf8");
    assert.match(content, /@agenthome-managed/);
    assert.ok(content.includes('"route"'), `route tool must run the route command:\n${content}`);
    assert.ok(content.includes('"--json"'), `route tool must request JSON output:\n${content}`);

    const before = await hashFile(tool);
    const second = await agenthome(sandbox, ["apply", harness, "--scope", "global"]);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /No changes/);
    assert.equal(await hashFile(tool), before, "second apply must not rewrite the route tool");
  });

  test(`apply ${harness} --scope global reports a conflict for an unmanaged route tool`, async (t) => {
    const sandbox = await makeSandbox(t);
    await initSandbox(sandbox);
    const tool = routeToolFile(sandbox, harness);
    await fs.mkdir(path.dirname(tool), { recursive: true });
    await fs.writeFile(tool, "// user tool, not managed\nexport default {};\n", "utf8");
    const before = await hashFile(tool);

    const result = await agenthome(sandbox, ["apply", harness, "--scope", "global"]);
    assert.notEqual(result.code, 0, "apply must fail when the route tool exists without the marker");
    assert.match(result.stdout + result.stderr, /not managed by AgentHome/);
    assert.equal(await hashFile(tool), before, "unmanaged route tool must not be overwritten");
  });
}

test("the generated pi route tool returns the project JSON with absolute artifacts", async (t) => {
  const sandbox = await makeSandbox(t);
  await initSandbox(sandbox);
  const applied = await agenthome(sandbox, ["apply", "pi", "--scope", "global"]);
  assert.equal(applied.code, 0, applied.stderr);
  const project = await indexProject(sandbox, "routed");
  const canonical = await fs.realpath(project);

  const run = await runPiTool(sandbox, routeToolFile(sandbox, "pi"), "routed");
  assert.equal(run.code, 0, run.stderr || run.stdout);
  const parsed = JSON.parse(run.stdout) as RouteResult;
  assert.equal(parsed.slug, "routed");
  assert.equal(parsed.path, canonical);
  assert.ok(
    parsed.artifacts.memory.includes(path.join(canonical, "MEMORY.md")),
    `memory artifacts must include MEMORY.md, got ${JSON.stringify(parsed.artifacts.memory)}`,
  );
  for (const value of parsed.artifacts.memory) assert.ok(path.isAbsolute(value), `expected absolute path, got '${value}'`);
});

test("the generated opencode route tool returns the project JSON with absolute artifacts", async (t) => {
  const sandbox = await makeSandbox(t);
  await initSandbox(sandbox);
  const applied = await agenthome(sandbox, ["apply", "opencode", "--scope", "global"]);
  assert.equal(applied.code, 0, applied.stderr);
  await writePluginStub(sandbox);
  const project = await indexProject(sandbox, "routed");
  const canonical = await fs.realpath(project);

  const result = await runOpenCodeTool(sandbox, routeToolFile(sandbox, "opencode"), "routed");
  assert.equal(typeof result, "string", `expected the tool to resolve a string, got ${typeof result}`);
  const parsed = JSON.parse(result as string) as RouteResult;
  assert.equal(parsed.slug, "routed");
  assert.equal(parsed.path, canonical);
  assert.ok(
    parsed.artifacts.memory.includes(path.join(canonical, "MEMORY.md")),
    `memory artifacts must include MEMORY.md, got ${JSON.stringify(parsed.artifacts.memory)}`,
  );
});

test("the pi route tool returns an unknown project failure without throwing", async (t) => {
  const sandbox = await makeSandbox(t);
  await initSandbox(sandbox);
  const applied = await agenthome(sandbox, ["apply", "pi", "--scope", "global"]);
  assert.equal(applied.code, 0, applied.stderr);

  const run = await runPiTool(sandbox, routeToolFile(sandbox, "pi"), "does-not-exist");
  assert.equal(run.code, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /No project matches 'does-not-exist'/);
});

test("the opencode route tool returns an unknown project failure starting with AgentHome route failed", async (t) => {
  const sandbox = await makeSandbox(t);
  await initSandbox(sandbox);
  const applied = await agenthome(sandbox, ["apply", "opencode", "--scope", "global"]);
  assert.equal(applied.code, 0, applied.stderr);
  await writePluginStub(sandbox);

  const result = await runOpenCodeTool(sandbox, routeToolFile(sandbox, "opencode"), "does-not-exist");
  assert.equal(typeof result, "string", `expected the tool to resolve a string, got ${typeof result}`);
  assert.match(result as string, /^AgentHome route failed/);
});

test("the pi route tool failure text starts with AgentHome route failed", async (t) => {
  const sandbox = await makeSandbox(t);
  await initSandbox(sandbox);
  const applied = await agenthome(sandbox, ["apply", "pi", "--scope", "global"]);
  assert.equal(applied.code, 0, applied.stderr);

  const run = await runPiTool(sandbox, routeToolFile(sandbox, "pi"), "does-not-exist");
  assert.equal(run.code, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /^AgentHome route failed/);
});
