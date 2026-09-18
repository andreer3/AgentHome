import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
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

function globalMcpFile(sandbox: Sandbox): string {
  return path.join(sandbox.home, ".pi", "agent", "mcp.json");
}

function projectMcpFile(sandbox: Sandbox): string {
  return path.join(sandbox.project, ".pi", "mcp.json");
}

function globalSettingsFile(sandbox: Sandbox): string {
  return path.join(sandbox.home, ".pi", "agent", "settings.json");
}

function projectSettingsFile(sandbox: Sandbox): string {
  return path.join(sandbox.project, ".pi", "settings.json");
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

async function writeProviders(sandbox: Sandbox, defaults: { provider: string; model: string }): Promise<void> {
  const file = path.join(sandbox.home, ".agenthome", "providers", "providers.yaml");
  await fs.writeFile(file, YAML.stringify({ defaults }), "utf8");
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
}

test("pi apply --scope global writes pi-specific mcp servers into ~/.pi/agent/mcp.json", async (t) => {
  const sandbox = await makeSandbox(t);
  await initSandbox(sandbox);
  await writeRegistry(globalRegistry(sandbox), {
    localone: {
      type: "local",
      command: ["node", "server.js"],
      lifecycle: "eager",
      environment: { MODE: "test" },
    },
    remoteone: {
      type: "remote",
      url: "https://example.com/mcp",
      lifecycle: "lazy",
      headers: { "X-Test": "fixture" },
    },
  });

  const result = await cli(sandbox, ["apply", "pi", "--scope", "global"]);
  assert.equal(result.code, 0, result.stderr);

  const parsed = await readJson(globalMcpFile(sandbox));
  assert.deepEqual(parsed, {
    mcpServers: {
      localone: {
        transport: "stdio",
        command: "node",
        args: ["server.js"],
        lifecycle: "eager",
        env: { MODE: "test" },
      },
      remoteone: {
        transport: "streamable-http",
        url: "https://example.com/mcp",
        lifecycle: "lazy",
        headers: { "X-Test": "fixture" },
      },
    },
  });
  const servers = parsed.mcpServers as Record<string, Record<string, unknown>>;
  assert.equal(typeof servers.localone?.command, "string", "pi local command must be a string");
  assert.ok(Array.isArray(servers.localone?.args), "pi local args must be an array");
  assert.deepEqual(servers.remoteone?.headers, { "X-Test": "fixture" }, "remote headers must be propagated");
  assert.equal(await hashFile(projectMcpFile(sandbox)), null, "global apply must not write .pi/mcp.json");
});

test("pi apply --scope project writes .pi/mcp.json and leaves the global file untouched", async (t) => {
  const sandbox = await makeSandbox(t);
  await initSandbox(sandbox);
  await writeRegistry(globalRegistry(sandbox), {
    gserver: { type: "local", command: ["node", "global.js"], lifecycle: "lazy" },
  });
  const globalApply = await cli(sandbox, ["apply", "pi", "--scope", "global"]);
  assert.equal(globalApply.code, 0, globalApply.stderr);
  const globalHash = await hashFile(globalMcpFile(sandbox));

  await writeRegistry(projectRegistry(sandbox), {
    premote: {
      type: "remote",
      url: "https://project.example.com/mcp",
      lifecycle: "eager",
      headers: { "X-Test": "fixture" },
    },
    plocal: { type: "local", command: ["node", "project.js"], lifecycle: "lazy" },
  });

  const result = await cli(sandbox, ["apply", "pi", "--scope", "project"]);
  assert.equal(result.code, 0, result.stderr);

  assert.deepEqual(await readJson(projectMcpFile(sandbox)), {
    mcpServers: {
      premote: {
        transport: "streamable-http",
        url: "https://project.example.com/mcp",
        lifecycle: "eager",
        headers: { "X-Test": "fixture" },
      },
      plocal: { transport: "stdio", command: "node", args: ["project.js"], lifecycle: "lazy" },
    },
  });
  assert.equal(await hashFile(globalMcpFile(sandbox)), globalHash, "global pi mcp.json must stay untouched");
  const globalRaw = await fs.readFile(globalMcpFile(sandbox), "utf8");
  assert.doesNotMatch(globalRaw, /premote|plocal/, "project servers must not leak into the global file");
});

test("pi skips servers with enabled false and doctor warns about them", async (t) => {
  const sandbox = await makeSandbox(t);
  await initSandbox(sandbox);
  await writeRegistry(globalRegistry(sandbox), {
    enabledone: { type: "local", command: ["node", "on.js"], lifecycle: "lazy" },
    disabledone: { type: "local", command: ["node", "off.js"], lifecycle: "lazy", enabled: false },
  });

  const result = await cli(sandbox, ["apply", "pi", "--scope", "global"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await readJson(globalMcpFile(sandbox)), {
    mcpServers: {
      enabledone: { transport: "stdio", command: "node", args: ["on.js"], lifecycle: "lazy" },
    },
  });
  const raw = await fs.readFile(globalMcpFile(sandbox), "utf8");
  assert.doesNotMatch(raw, /disabledone/, "disabled servers must not be emitted for pi");

  const doctor = await cli(sandbox, ["doctor"]);
  assert.equal(doctor.code, 0, doctor.stderr);
  assert.match(doctor.stdout, /MCP 'disabledone' is disabled and will be skipped for pi/);
});

test("pi settings come from providers.defaults and are skipped without defaults", async (t) => {
  const sandbox = await makeSandbox(t);
  await initSandbox(sandbox);

  const withoutDefaults = await cli(sandbox, ["apply", "pi", "--scope", "all"]);
  assert.equal(withoutDefaults.code, 0, withoutDefaults.stderr);
  assert.equal(await hashFile(globalSettingsFile(sandbox)), null, "no defaults must not create global settings");
  assert.equal(await hashFile(projectSettingsFile(sandbox)), null, "no defaults must not create project settings");

  await writeProviders(sandbox, { provider: "prov", model: "id" });

  const globalApply = await cli(sandbox, ["apply", "pi", "--scope", "global"]);
  assert.equal(globalApply.code, 0, globalApply.stderr);
  assert.deepEqual(await readJson(globalSettingsFile(sandbox)), { defaultProvider: "prov", defaultModel: "id" });

  const projectApply = await cli(sandbox, ["apply", "pi", "--scope", "project"]);
  assert.equal(projectApply.code, 0, projectApply.stderr);
  assert.deepEqual(await readJson(projectSettingsFile(sandbox)), { defaultProvider: "prov", defaultModel: "id" });
});

test("pi apply is idempotent", async (t) => {
  const sandbox = await makeSandbox(t);
  await initSandbox(sandbox);
  await writeRegistry(globalRegistry(sandbox), {
    remoteone: {
      type: "remote",
      url: "https://example.com/mcp",
      lifecycle: "lazy",
      headers: { "X-Test": "fixture" },
    },
  });
  await writeProviders(sandbox, { provider: "prov", model: "id" });

  const first = await cli(sandbox, ["apply", "pi", "--scope", "global"]);
  assert.equal(first.code, 0, first.stderr);
  const mcpHash = await hashFile(globalMcpFile(sandbox));
  const settingsHash = await hashFile(globalSettingsFile(sandbox));

  const second = await cli(sandbox, ["apply", "pi", "--scope", "global"]);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /No changes/);
  assert.equal(await hashFile(globalMcpFile(sandbox)), mcpHash, "second apply must not change mcp.json");
  assert.equal(await hashFile(globalSettingsFile(sandbox)), settingsHash, "second apply must not change settings.json");
});
