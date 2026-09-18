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

interface IndexedArtifacts {
  memory: string[];
  rules: string[];
  skills: string[];
  mcp: string[];
}

interface IndexedEntry {
  path: string;
  aliases: string[];
  last_seen: string;
  artifacts_changed_at: string;
  artifacts_signature: string;
  harnesses: string[];
  artifacts: IndexedArtifacts;
}

interface IndexedDocument {
  projects: Record<string, IndexedEntry>;
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

/** Index commands only accept --home; cwd is already the sandbox project. */
function agenthome(sandbox: Sandbox, args: string[]): Promise<CliResult> {
  return runCli([...args, "--home", sandbox.home], sandbox);
}

function indexFile(sandbox: Sandbox): string {
  return path.join(sandbox.home, ".agenthome", "projects.yaml");
}

async function readIndex(sandbox: Sandbox): Promise<IndexedDocument> {
  return YAML.parse(await fs.readFile(indexFile(sandbox), "utf8")) as IndexedDocument;
}

async function register(sandbox: Sandbox, project: string, harness: string): Promise<void> {
  const result = await agenthome(sandbox, ["register", "--path", project, "--harness", harness]);
  assert.equal(result.code, 0, result.stderr);
}

async function makeProject(root: string, name: string): Promise<string> {
  const project = path.join(root, name);
  await fs.mkdir(project, { recursive: true });
  return project;
}

async function touchArtifact(project: string, relative: string): Promise<void> {
  const target = path.join(project, relative);
  if (relative.endsWith("skills")) {
    await fs.mkdir(target, { recursive: true });
    return;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "test fixture\n", "utf8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

test("register is silent, canonicalizes the path and detects artifacts", async (t) => {
  const sandbox = await makeSandbox(t);
  const project = await makeProject(sandbox.root, "sample-app");
  for (const relative of [".agenthome/memory.md", "MEMORY.md", "AGENTS.md", ".agents/skills", "opencode.jsonc"]) {
    await touchArtifact(project, relative);
  }

  const result = await agenthome(sandbox, ["register", "--path", project, "--harness", "opencode"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "", "register must stay silent");
  assert.equal(result.stderr, "", "register must stay silent");

  const doc = await readIndex(sandbox);
  assert.deepEqual(Object.keys(doc.projects), ["sample-app"]);
  const entry = doc.projects["sample-app"]!;
  assert.equal(entry.path, await fs.realpath(project));
  assert.deepEqual(entry.harnesses, ["opencode"]);
  assert.deepEqual(entry.aliases, []);
  assert.ok(!Number.isNaN(Date.parse(entry.last_seen)), "last_seen must be an ISO timestamp");
  assert.equal(entry.artifacts_changed_at, entry.last_seen);
  assert.equal(entry.artifacts_signature, JSON.stringify(entry.artifacts));
  assert.deepEqual(entry.artifacts, {
    memory: [".agenthome/memory.md", "MEMORY.md"],
    rules: ["AGENTS.md"],
    skills: [".agents/skills"],
    mcp: ["opencode.jsonc"],
  });
});

test("register succeeds silently without writing when the path does not exist", async (t) => {
  const sandbox = await makeSandbox(t);
  const result = await agenthome(sandbox, [
    "register",
    "--path",
    path.join(sandbox.root, "missing-project"),
    "--harness",
    "pi",
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(await hashFile(indexFile(sandbox)), null, "missing path must not create the index");
});

test("register merges repeated harnesses for the same project", async (t) => {
  const sandbox = await makeSandbox(t);
  const project = await makeProject(sandbox.root, "shared-app");

  await register(sandbox, project, "pi");
  await sleep(20);
  await register(sandbox, project, "opencode");
  await register(sandbox, project, "pi");

  const doc = await readIndex(sandbox);
  assert.deepEqual(Object.keys(doc.projects), ["shared-app"]);
  assert.deepEqual(doc.projects["shared-app"]!.harnesses, ["pi", "opencode"]);
});

test("register bumps artifacts_changed_at only when the artifact signature changes", async (t) => {
  const sandbox = await makeSandbox(t);
  const project = await makeProject(sandbox.root, "changing");

  await register(sandbox, project, "pi");
  const first = (await readIndex(sandbox)).projects["changing"]!;
  assert.equal(first.artifacts_changed_at, first.last_seen);

  await sleep(30);
  await register(sandbox, project, "opencode");
  const same = (await readIndex(sandbox)).projects["changing"]!;
  assert.equal(same.artifacts_changed_at, first.artifacts_changed_at);
  assert.equal(same.artifacts_signature, first.artifacts_signature);
  assert.ok(same.last_seen > first.last_seen);

  await sleep(30);
  await touchArtifact(project, "MEMORY.md");
  await register(sandbox, project, "pi");
  const changed = (await readIndex(sandbox)).projects["changing"]!;
  assert.ok(changed.artifacts_changed_at > first.artifacts_changed_at);
  assert.equal(changed.artifacts_changed_at, changed.last_seen);
  assert.notEqual(changed.artifacts_signature, first.artifacts_signature);
});

test("projects list hides artifact-less projects by default and sorts by change time", async (t) => {
  const sandbox = await makeSandbox(t);
  const alpha = await makeProject(sandbox.root, "alpha");
  const beta = await makeProject(sandbox.root, "beta");
  const empty = await makeProject(sandbox.root, "empty");

  await register(sandbox, empty, "pi");
  await sleep(30);
  await touchArtifact(alpha, "MEMORY.md");
  await register(sandbox, alpha, "pi");
  await sleep(30);
  await touchArtifact(beta, "AGENTS.md");
  await register(sandbox, beta, "opencode");
  await sleep(30);
  await register(sandbox, alpha, "pi");

  const json = await agenthome(sandbox, ["projects", "list", "--json"]);
  assert.equal(json.code, 0, json.stderr);
  const parsed = JSON.parse(json.stdout) as IndexedDocument;
  assert.deepEqual(Object.keys(parsed.projects), ["beta", "alpha"]);
  assert.ok(parsed.projects["alpha"]!.last_seen > parsed.projects["beta"]!.last_seen);
  assert.ok(parsed.projects["beta"]!.artifacts_changed_at >= parsed.projects["alpha"]!.artifacts_changed_at);

  const human = await agenthome(sandbox, ["projects", "list"]);
  assert.equal(human.code, 0, human.stderr);
  const lines = human.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^beta\t/);
  assert.match(lines[1]!, /^alpha\t/);
  assert.match(lines[0]!, /\[opencode\] rules:1 seen:\d{4}-\d{2}-\d{2} changed:\d{4}-\d{2}-\d{2}$/);
  assert.ok(!human.stdout.includes("empty"), "artifact-less projects stay hidden by default");

  const all = await agenthome(sandbox, ["projects", "list", "--all", "--json"]);
  assert.equal(all.code, 0, all.stderr);
  const allParsed = JSON.parse(all.stdout) as IndexedDocument;
  assert.deepEqual(Object.keys(allParsed.projects), ["beta", "alpha", "empty"]);

  const allHuman = await agenthome(sandbox, ["projects", "list", "--all"]);
  assert.equal(allHuman.code, 0, allHuman.stderr);
  const emptyLine = allHuman.stdout.trimEnd().split("\n").find((line) => line.startsWith("empty\t"));
  assert.ok(emptyLine, "artifact-less project must appear with --all");
  assert.match(emptyLine!, /no-artifacts/);
});

test("projects list reports an empty index", async (t) => {
  const sandbox = await makeSandbox(t);

  const human = await agenthome(sandbox, ["projects", "list"]);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /No projects with memory\/rules\/skills indexed yet/);

  const all = await agenthome(sandbox, ["projects", "list", "--all"]);
  assert.equal(all.code, 0, all.stderr);
  assert.match(all.stdout, /No projects indexed yet/);

  const json = await agenthome(sandbox, ["projects", "list", "--json"]);
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), { projects: {} });

  const jsonAll = await agenthome(sandbox, ["projects", "list", "--all", "--json"]);
  assert.equal(jsonAll.code, 0, jsonAll.stderr);
  assert.deepEqual(JSON.parse(jsonAll.stdout), { projects: {} });
});

test("projects show/alias/remove resolve by slug, alias, folder name and path", async (t) => {
  const sandbox = await makeSandbox(t);
  const project = await makeProject(sandbox.root, "Alpha App");
  await fs.writeFile(path.join(project, "MEMORY.md"), "# memory\n", "utf8");
  await register(sandbox, project, "pi");
  const canonical = await fs.realpath(project);

  const bySlug = await agenthome(sandbox, ["projects", "show", "alpha-app"]);
  assert.equal(bySlug.code, 0, bySlug.stderr);
  assert.match(bySlug.stdout, /^alpha-app\n/);
  assert.ok(bySlug.stdout.includes(`path: ${canonical}`));

  const byFolder = await agenthome(sandbox, ["projects", "show", "Alpha App"]);
  assert.equal(byFolder.code, 0, byFolder.stderr);
  assert.match(byFolder.stdout, /^alpha-app\n/);

  const byPath = await agenthome(sandbox, ["projects", "show", canonical]);
  assert.equal(byPath.code, 0, byPath.stderr);
  assert.match(byPath.stdout, /^alpha-app\n/);

  const aliased = await agenthome(sandbox, ["projects", "alias", "alpha-app", "my-alias", "my-alias"]);
  assert.equal(aliased.code, 0, aliased.stderr);
  assert.match(aliased.stdout, /alpha-app: aliases = my-alias/);

  const byAlias = await agenthome(sandbox, ["projects", "show", "MY-ALIAS"]);
  assert.equal(byAlias.code, 0, byAlias.stderr);
  assert.match(byAlias.stdout, /^alpha-app\n/);

  const json = await agenthome(sandbox, ["projects", "show", "my-alias", "--json"]);
  assert.equal(json.code, 0, json.stderr);
  const shown = JSON.parse(json.stdout) as Record<string, unknown>;
  assert.equal(shown.slug, "alpha-app");
  assert.equal(shown.path, canonical);
  assert.deepEqual(shown.aliases, ["my-alias"]);
  assert.deepEqual(shown.harnesses, ["pi"]);
  assert.deepEqual(shown.artifacts, { memory: ["MEMORY.md"], rules: [], skills: [], mcp: [] });

  const removed = await agenthome(sandbox, ["projects", "remove", "my-alias"]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.match(removed.stdout, /Removed 'alpha-app'/);
  assert.deepEqual((await readIndex(sandbox)).projects, {});
  assert.notEqual(await hashFile(path.join(project, "MEMORY.md")), null, "remove must not touch project files");
});

test("ambiguous or unknown project queries fail with a non-zero exit", async (t) => {
  const sandbox = await makeSandbox(t);
  const one = await makeProject(sandbox.root, "one/dup");
  const two = await makeProject(sandbox.root, "two/dup");
  await register(sandbox, one, "pi");
  await sleep(20);
  await register(sandbox, two, "pi");

  const ambiguous = await agenthome(sandbox, ["projects", "show", "dup"]);
  assert.notEqual(ambiguous.code, 0);
  assert.match(ambiguous.stderr, /matches several projects/);
  assert.match(ambiguous.stderr, /dup-2/);

  const unknown = await agenthome(sandbox, ["projects", "show", "does-not-exist"]);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /No project matches/);

  const ambiguousRoute = await agenthome(sandbox, ["route", "dup"]);
  assert.notEqual(ambiguousRoute.code, 0);
  assert.match(ambiguousRoute.stderr, /matches several projects/);

  const unknownRoute = await agenthome(sandbox, ["route", "does-not-exist"]);
  assert.notEqual(unknownRoute.code, 0);
  assert.match(unknownRoute.stderr, /No project matches/);
});

test("route returns absolute paths only, in human and JSON form", async (t) => {
  const sandbox = await makeSandbox(t);
  const project = await makeProject(sandbox.root, "routed");
  for (const relative of [".agenthome/memory.md", "MEMORY.md", "AGENTS.md", ".agents/skills", "opencode.jsonc"]) {
    await touchArtifact(project, relative);
  }
  await register(sandbox, project, "opencode");
  const canonical = await fs.realpath(project);
  const expected: IndexedArtifacts = {
    memory: [".agenthome/memory.md", "MEMORY.md"].map((relative) => path.join(canonical, relative)),
    rules: [path.join(canonical, "AGENTS.md")],
    skills: [path.join(canonical, ".agents/skills")],
    mcp: [path.join(canonical, "opencode.jsonc")],
  };

  const json = await agenthome(sandbox, ["route", "routed", "--json"]);
  assert.equal(json.code, 0, json.stderr);
  const parsed = JSON.parse(json.stdout) as Record<string, unknown>;
  assert.equal(parsed.slug, "routed");
  assert.equal(parsed.path, canonical);
  assert.deepEqual(parsed.artifacts, expected);
  for (const values of Object.values(parsed.artifacts as unknown as Record<string, string[]>)) {
    for (const value of values) {
      assert.ok(path.isAbsolute(value), `route must return absolute paths, got '${value}'`);
    }
  }

  const human = await agenthome(sandbox, ["route", "routed"]);
  assert.equal(human.code, 0, human.stderr);
  for (const values of Object.values(expected)) {
    for (const value of values) assert.ok(human.stdout.includes(value), `route output must include ${value}`);
  }
  assert.match(human.stdout, /read these paths on demand/);
});

test("summary counts projects with artifacts and orders recently changed by real changes", async (t) => {
  const sandbox = await makeSandbox(t);

  const empty = await agenthome(sandbox, ["summary", "--json"]);
  assert.equal(empty.code, 0, empty.stderr);
  assert.deepEqual(JSON.parse(empty.stdout), {
    projects: 0,
    withArtifacts: 0,
    withMemory: 0,
    withSkills: 0,
    recentlyChanged: [],
  });
  const emptyHuman = await agenthome(sandbox, ["summary"]);
  assert.equal(emptyHuman.code, 0, emptyHuman.stderr);
  assert.match(emptyHuman.stdout, /AgentHome projects: 0 \(0 with memory\/rules\/skills, 0 without\)/);

  const projects: string[] = [];
  for (let index = 1; index <= 6; index += 1) {
    const project = await makeProject(sandbox.root, `p${index}`);
    if (index <= 5) await touchArtifact(project, "MEMORY.md");
    if (index <= 2) await touchArtifact(project, ".agents/skills");
    await register(sandbox, project, "pi");
    projects.push(project);
    await sleep(25);
  }

  await sleep(25);
  await register(sandbox, projects[1]!, "opencode");

  const json = await agenthome(sandbox, ["summary", "--json"]);
  assert.equal(json.code, 0, json.stderr);
  const parsed = JSON.parse(json.stdout) as {
    projects: number;
    withArtifacts: number;
    withMemory: number;
    withSkills: number;
    recentlyChanged: Array<{ slug: string; artifacts_changed_at: string }>;
  };
  assert.equal(parsed.projects, 6);
  assert.equal(parsed.withArtifacts, 5);
  assert.equal(parsed.withMemory, 5);
  assert.equal(parsed.withSkills, 2);
  assert.deepEqual(parsed.recentlyChanged.map((recent) => recent.slug), ["p5", "p4", "p3", "p2", "p1"]);
  assert.ok(parsed.recentlyChanged.every((recent) => !Number.isNaN(Date.parse(recent.artifacts_changed_at))));
  const changes = parsed.recentlyChanged.map((recent) => Date.parse(recent.artifacts_changed_at));
  assert.deepEqual(changes, [...changes].sort((a, b) => b - a));

  const index = await readIndex(sandbox);
  assert.ok(index.projects["p2"]!.last_seen > index.projects["p5"]!.last_seen, "p2 was restarted last");
  assert.equal(parsed.recentlyChanged[0]!.slug, "p5", "ordering follows changes, not starts");

  const human = await agenthome(sandbox, ["summary"]);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /AgentHome projects: 6 \(5 with memory\/rules\/skills, 1 without\)/);
  assert.match(human.stdout, /with memory: 5/);
  assert.match(human.stdout, /with skills: 2/);
  assert.match(human.stdout, /recently changed:/);
  const recentBlock = human.stdout.split("recently changed:")[1]!;
  assert.ok(recentBlock.indexOf("p5") < recentBlock.indexOf("p4"));
  assert.ok(!recentBlock.includes("p6"), "artifact-less projects are never recently changed");
});
