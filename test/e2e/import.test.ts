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

const MANAGED_MARKER = "@agenthome-managed";

const USER_MCP: Record<string, unknown> = {
  localone: { type: "local", command: ["node", "server.js"], enabled: true },
  remoteone: {
    type: "remote",
    url: "https://example.com/mcp",
    headers: { Accept: "application/json" },
  },
};

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

function globalFiles(sandbox: Sandbox): { registry: string; providers: string } {
  return {
    registry: path.join(sandbox.home, ".agenthome", "mcp", "registry.yaml"),
    providers: path.join(sandbox.home, ".agenthome", "providers", "providers.yaml"),
  };
}

function userOpenCodeFile(sandbox: Sandbox): string {
  return path.join(sandbox.home, ".config", "opencode", "opencode.json");
}

async function writeUserOpenCode(
  sandbox: Sandbox,
  config: { model?: string; mcp: Record<string, unknown> },
): Promise<void> {
  const file = userOpenCodeFile(sandbox);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function readYaml(file: string): Promise<Record<string, unknown>> {
  return YAML.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
}

test("import opencode --dry-run reports the plan without writing", async (t) => {
  const sandbox = await makeSandbox(t);
  await initSandbox(sandbox);
  await writeUserOpenCode(sandbox, { model: "prov/id", mcp: USER_MCP });
  const { registry, providers } = globalFiles(sandbox);
  const registryHash = await hashFile(registry);
  const providersHash = await hashFile(providers);

  const result = await cli(sandbox, ["import", "opencode", "--dry-run"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Adoption source: .*opencode\.json/);
  assert.match(result.stdout, /mcp adopted: localone, remoteone/);
  assert.match(result.stdout, /model adopted: prov\/id/);
  assert.match(result.stdout, /Planned changes:/);
  assert.equal(await hashFile(registry), registryHash, "dry-run must not write registry.yaml");
  assert.equal(await hashFile(providers), providersHash, "dry-run must not write providers.yaml");
});

test("import opencode adopts servers and model and is idempotent", async (t) => {
  const sandbox = await makeSandbox(t);
  await initSandbox(sandbox);
  await writeUserOpenCode(sandbox, { model: "prov/id", mcp: USER_MCP });
  const { registry, providers } = globalFiles(sandbox);

  const first = await cli(sandbox, ["import", "opencode"]);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /mcp adopted: localone, remoteone/);
  assert.match(first.stdout, /model adopted: prov\/id/);
  const registryDoc = await readYaml(registry);
  const servers = registryDoc.servers as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(servers), ["localone", "remoteone"]);
  assert.equal(servers.localone.type, "local");
  assert.deepEqual(servers.localone.command, ["node", "server.js"]);
  assert.equal(servers.localone.enabled, true);
  assert.equal(servers.remoteone.type, "remote");
  assert.equal(servers.remoteone.url, "https://example.com/mcp");
  assert.deepEqual(servers.remoteone.headers, { Accept: "application/json" });
  const providersDoc = await readYaml(providers);
  assert.deepEqual(providersDoc.defaults, { provider: "prov", model: "id" });

  const registryHash = await hashFile(registry);
  const providersHash = await hashFile(providers);
  const second = await cli(sandbox, ["import", "opencode"]);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /mcp already in AgentHome: localone, remoteone/);
  assert.match(second.stdout, /model already in AgentHome: prov\/id/);
  assert.match(second.stdout, /No changes\./);
  assert.equal(await hashFile(registry), registryHash, "re-import must not rewrite registry.yaml");
  assert.equal(await hashFile(providers), providersHash, "re-import must not rewrite providers.yaml");
});

test("import opencode reports clashes and only adopts the user's entry with --force", async (t) => {
  const sandbox = await makeSandbox(t);
  await initSandbox(sandbox);
  await writeUserOpenCode(sandbox, {
    model: "canonical/model",
    mcp: { shared: { type: "local", command: ["node", "canonical.js"], enabled: true } },
  });
  const { registry, providers } = globalFiles(sandbox);

  const first = await cli(sandbox, ["import", "opencode"]);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /mcp adopted: shared/);
  const registryHash = await hashFile(registry);
  const providersHash = await hashFile(providers);

  await writeUserOpenCode(sandbox, {
    model: "user/model",
    mcp: { shared: { type: "local", command: ["node", "user.js"], enabled: true } },
  });

  const clash = await cli(sandbox, ["import", "opencode"]);
  assert.equal(clash.code, 0, clash.stderr);
  assert.match(clash.stdout, /mcp clash \(AgentHome wins\): shared \(use --force to adopt yours\)/);
  assert.match(clash.stdout, /model clash \(AgentHome wins\): user\/model \(use --force to adopt yours\)/);
  assert.equal(await hashFile(registry), registryHash, "clash without --force must not rewrite registry.yaml");
  assert.equal(await hashFile(providers), providersHash, "clash without --force must not rewrite providers.yaml");
  const clashDoc = await readYaml(registry);
  const clashServers = clashDoc.servers as Record<string, Record<string, unknown>>;
  assert.deepEqual(clashServers.shared?.command, ["node", "canonical.js"]);

  const forced = await cli(sandbox, ["import", "opencode", "--force"]);
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(forced.stdout, /mcp replaced \(--force\): shared/);
  assert.match(forced.stdout, /model replaced \(--force\): user\/model/);
  const forcedDoc = await readYaml(registry);
  const forcedServers = forcedDoc.servers as Record<string, Record<string, unknown>>;
  assert.deepEqual(forcedServers.shared?.command, ["node", "user.js"], "--force must adopt the user's entry");
  const forcedProviders = await readYaml(providers);
  assert.deepEqual(forcedProviders.defaults, { provider: "user", model: "model" });
});

test("import opencode reports invalid mcp servers and does not adopt them", async (t) => {
  const sandbox = await makeSandbox(t);
  await initSandbox(sandbox);
  await writeUserOpenCode(sandbox, {
    mcp: {
      goodone: { type: "local", command: ["node", "ok.js"], enabled: true },
      broken: { type: "local" },
    },
  });
  const { registry } = globalFiles(sandbox);

  const result = await cli(sandbox, ["import", "opencode"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /mcp invalid \(not adopted\): broken/);
  assert.match(result.stdout, /require command/);
  const doc = await readYaml(registry);
  const servers = doc.servers as Record<string, unknown>;
  assert.deepEqual(Object.keys(servers), ["goodone"]);
});

test("import opencode reports a malformed model and does not adopt it", async (t) => {
  const sandbox = await makeSandbox(t);
  await initSandbox(sandbox);
  await writeUserOpenCode(sandbox, { model: "gpt-4", mcp: {} });
  const { providers } = globalFiles(sandbox);
  const before = await hashFile(providers);

  const result = await cli(sandbox, ["import", "opencode"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /model invalid \(not adopted\): gpt-4/);
  assert.equal(await hashFile(providers), before, "malformed model must not be written");
});

test("import opencode --scope global ignores the project OpenCode config", async (t) => {
  const sandbox = await makeSandbox(t);
  await initSandbox(sandbox);
  await writeUserOpenCode(sandbox, {
    mcp: { globalone: { type: "local", command: ["node", "global.js"], enabled: true } },
  });
  await fs.writeFile(
    path.join(sandbox.project, "opencode.json"),
    `${JSON.stringify({ mcp: { projectone: { type: "local", command: ["node", "project.js"], enabled: true } } }, null, 2)}\n`,
    "utf8",
  );
  const { registry } = globalFiles(sandbox);

  const result = await cli(sandbox, ["import", "opencode", "--scope", "global"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /mcp adopted: globalone/);
  assert.doesNotMatch(result.stdout, /projectone/);

  const doc = await readYaml(registry);
  assert.deepEqual(Object.keys(doc.servers as Record<string, unknown>), ["globalone"]);
  const projectRegistry = path.join(sandbox.project, ".agenthome", "mcp.yaml");
  const projectDoc = await readYaml(projectRegistry);
  assert.deepEqual(Object.keys(projectDoc.servers as Record<string, unknown>), []);
});

test("import opencode ignores managed files as sources", async (t) => {
  const sandbox = await makeSandbox(t);
  await initSandbox(sandbox);
  const dir = path.join(sandbox.home, ".config", "opencode");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "opencode.json"),
    [
      `// ${MANAGED_MARKER}`,
      "// Generated by AgentHome. Manual edits to this file may be overwritten.",
      "{",
      '  "mcp": {',
      '    "frommanaged": {',
      '      "type": "local",',
      '      "command": ["node", "managed.js"]',
      "    }",
      "  }",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "opencode.jsonc"),
    `${JSON.stringify({ mcp: { fromuser: { type: "local", command: ["node", "user.js"] } } }, null, 2)}\n`,
    "utf8",
  );
  const { registry } = globalFiles(sandbox);

  const result = await cli(sandbox, ["import", "opencode"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Adoption source: .*opencode\.jsonc/);
  assert.doesNotMatch(result.stdout, /frommanaged/);
  const doc = await readYaml(registry);
  const servers = doc.servers as Record<string, unknown>;
  assert.deepEqual(Object.keys(servers), ["fromuser"]);
});
