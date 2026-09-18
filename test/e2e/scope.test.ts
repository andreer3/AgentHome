import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { parse, type ParseError } from "jsonc-parser";
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

/** CLI invocation with explicit --home/--project; cwd is already the sandbox project. */
function cli(sandbox: Sandbox, args: string[]): Promise<CliResult> {
  return runCli([...args, "--home", sandbox.home, "--project", sandbox.project], sandbox);
}

async function initSandbox(sandbox: Sandbox): Promise<void> {
  const result = await cli(sandbox, ["init"]);
  assert.equal(result.code, 0, result.stderr);
}

function globalConfigFile(sandbox: Sandbox): string {
  return path.join(sandbox.home, ".config", "opencode", "opencode.jsonc");
}

function projectConfigFile(sandbox: Sandbox): string {
  return path.join(sandbox.project, "opencode.jsonc");
}

function globalRegistry(sandbox: Sandbox): string {
  return path.join(sandbox.home, ".agenthome", "mcp", "registry.yaml");
}

function projectRegistry(sandbox: Sandbox): string {
  return path.join(sandbox.project, ".agenthome", "mcp.yaml");
}

async function writeRegistry(file: string, servers: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, YAML.stringify({ servers }), "utf8");
}

async function readJsonc(file: string): Promise<Record<string, unknown>> {
  const errors: ParseError[] = [];
  const parsed = parse(await fs.readFile(file, "utf8"), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  assert.equal(errors.length, 0, `expected valid JSONC: ${file}`);
  return parsed as Record<string, unknown>;
}

async function readYaml(file: string): Promise<Record<string, unknown>> {
  return YAML.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("apply scopes do not leak servers between the global and project registries", async (t) => {
  const sandbox = await makeSandbox(t);
  await initSandbox(sandbox);
  await writeRegistry(globalRegistry(sandbox), {
    gserver: { type: "local", command: ["node", "g.js"], lifecycle: "lazy" },
  });
  await writeRegistry(projectRegistry(sandbox), {
    pserver: { type: "remote", url: "https://project.example.com/mcp", lifecycle: "lazy", enabled: false },
  });

  const project = await cli(sandbox, ["apply", "opencode", "--scope", "project"]);
  assert.equal(project.code, 0, project.stderr);
  assert.deepEqual((await readJsonc(projectConfigFile(sandbox))).mcp, {
    pserver: { type: "remote", url: "https://project.example.com/mcp", enabled: false },
  });
  assert.doesNotMatch(await fs.readFile(projectConfigFile(sandbox), "utf8"), /gserver/);

  const global = await cli(sandbox, ["apply", "opencode", "--scope", "global"]);
  assert.equal(global.code, 0, global.stderr);
  assert.deepEqual((await readJsonc(globalConfigFile(sandbox))).mcp, {
    gserver: { type: "local", command: ["node", "g.js"], enabled: true },
  });
  assert.doesNotMatch(await fs.readFile(globalConfigFile(sandbox), "utf8"), /pserver/);
});

test("doctor warns when a server exists in both scopes and the project entry wins", async (t) => {
  const sandbox = await makeSandbox(t);
  await initSandbox(sandbox);
  await writeRegistry(globalRegistry(sandbox), {
    shared: { type: "remote", url: "https://global.example.com/mcp", lifecycle: "lazy" },
  });
  await writeRegistry(projectRegistry(sandbox), {
    shared: { type: "remote", url: "https://project.example.com/mcp", lifecycle: "lazy" },
  });

  const doctor = await cli(sandbox, ["doctor"]);
  assert.equal(doctor.code, 0, doctor.stderr);
  assert.match(doctor.stdout, /MCP global registry valid \(1 servers\)/);
  assert.match(doctor.stdout, /MCP project registry valid \(1 servers\)/);
  assert.match(
    doctor.stdout,
    /MCP 'shared' is defined in both scopes with different content; the project entry wins/,
  );

  const apply = await cli(sandbox, ["apply", "opencode", "--scope", "project"]);
  assert.equal(apply.code, 0, apply.stderr);
  const mcp = (await readJsonc(projectConfigFile(sandbox))).mcp as Record<string, Record<string, unknown>>;
  assert.equal(mcp.shared?.url, "https://project.example.com/mcp");
});

test("apply --scope all emits each registry into its own scope exactly once", async (t) => {
  const sandbox = await makeSandbox(t);
  await initSandbox(sandbox);
  await writeRegistry(globalRegistry(sandbox), {
    gserver: { type: "local", command: ["node", "g.js"], lifecycle: "lazy" },
  });
  await writeRegistry(projectRegistry(sandbox), {
    pserver: { type: "local", command: ["node", "p.js"], lifecycle: "lazy" },
  });

  const result = await cli(sandbox, ["apply", "opencode", "--scope", "all"]);
  assert.equal(result.code, 0, result.stderr);

  const globalRaw = await fs.readFile(globalConfigFile(sandbox), "utf8");
  const projectRaw = await fs.readFile(projectConfigFile(sandbox), "utf8");
  assert.equal(count(globalRaw, "gserver"), 1);
  assert.equal(count(globalRaw, "pserver"), 0);
  assert.equal(count(projectRaw, "pserver"), 1);
  assert.equal(count(projectRaw, "gserver"), 0);
  assert.deepEqual((await readJsonc(globalConfigFile(sandbox))).mcp, {
    gserver: { type: "local", command: ["node", "g.js"], enabled: true },
  });
  assert.deepEqual((await readJsonc(projectConfigFile(sandbox))).mcp, {
    pserver: { type: "local", command: ["node", "p.js"], enabled: true },
  });
});

test("import opencode --scope project writes the project registry only", async (t) => {
  const sandbox = await makeSandbox(t);
  await initSandbox(sandbox);
  await writeRegistry(globalRegistry(sandbox), {
    gserver: { type: "local", command: ["node", "g.js"], lifecycle: "lazy" },
  });
  const globalHash = await hashFile(globalRegistry(sandbox));

  const userProject = path.join(sandbox.project, "opencode.json");
  await fs.writeFile(
    userProject,
    `${JSON.stringify({ mcp: { projimported: { type: "local", command: ["node", "p.js"], enabled: true } } }, null, 2)}\n`,
    "utf8",
  );

  const result = await cli(sandbox, ["import", "opencode", "--scope", "project"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /mcp adopted: projimported/);

  const projectDoc = await readYaml(projectRegistry(sandbox));
  assert.deepEqual(Object.keys(projectDoc.servers as Record<string, unknown>), ["projimported"]);
  assert.equal(await hashFile(globalRegistry(sandbox)), globalHash, "global registry must stay untouched");
});
