import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import YAML from "yaml";
import {
  absoluteArtifacts,
  detectArtifacts,
  hasArtifacts,
  indexFile,
  loadIndex,
  registerProject,
  requireProject,
  resolveProject,
  saveIndex,
  slugify,
  type ProjectArtifacts,
  type ProjectEntry,
  type ProjectsIndex,
} from "../../src/core/projects.js";
import { createSandbox, type Sandbox } from "../helpers/sandbox.js";

function emptyArtifacts(): ProjectArtifacts {
  return { memory: [], rules: [], skills: [], mcp: [] };
}

function makeEntry(overrides: Partial<ProjectEntry> = {}): ProjectEntry {
  return {
    path: "/projects/alpha",
    aliases: [],
    last_seen: "2026-01-01T00:00:00.000Z",
    artifacts_changed_at: "2026-01-01T00:00:00.000Z",
    artifacts_signature: "",
    harnesses: [],
    artifacts: emptyArtifacts(),
    ...overrides,
  };
}

async function withSandboxHome<T>(fn: (sandbox: Sandbox) => Promise<T>): Promise<T> {
  const sandbox = await createSandbox();
  const previousHome = process.env.HOME;
  process.env.HOME = sandbox.home;
  try {
    return await fn(sandbox);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await sandbox.cleanup();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

describe("slugify", () => {
  it("lowercases and hyphenates words", () => {
    assert.equal(slugify("My Project"), "my-project");
  });

  it("strips diacritics", () => {
    assert.equal(slugify("Café Rincón"), "cafe-rincon");
  });

  it("collapses punctuation and trims separators", () => {
    assert.equal(slugify("  --Hello---World--  "), "hello-world");
  });

  it("falls back to 'project' when nothing usable remains", () => {
    assert.equal(slugify("!!!"), "project");
    assert.equal(slugify(""), "project");
  });
});

describe("resolveProject", () => {
  const index: ProjectsIndex = {
    projects: {
      alpha: makeEntry({ path: "/work/alpha", aliases: ["the-alpha"] }),
      "beta-tools": makeEntry({ path: "/work/beta-tools" }),
      webshop: makeEntry({ path: "/work/deep/nested/webshop" }),
      shop: makeEntry({ path: "/work/precious", aliases: ["my-precious-project"] }),
    },
  };

  it("matches an exact slug", () => {
    const result = resolveProject(index, "alpha");
    assert.equal(result.kind, "match");
    if (result.kind === "match") assert.equal(result.slug, "alpha");
  });

  it("matches an alias case-insensitively", () => {
    const result = resolveProject(index, "THE-ALPHA");
    assert.equal(result.kind, "match");
    if (result.kind === "match") assert.equal(result.slug, "alpha");
  });

  it("matches a folder name", () => {
    const result = resolveProject(index, "webshop");
    assert.equal(result.kind, "match");
    if (result.kind === "match") assert.equal(result.slug, "webshop");
  });

  it("matches an absolute path", () => {
    const result = resolveProject(index, "/work/beta-tools");
    assert.equal(result.kind, "match");
    if (result.kind === "match") assert.equal(result.slug, "beta-tools");
  });

  it("matches a path suffix", () => {
    const result = resolveProject(index, "nested/webshop");
    assert.equal(result.kind, "match");
    if (result.kind === "match") assert.equal(result.slug, "webshop");
  });

  it("matches a partial alias", () => {
    const result = resolveProject(index, "precious");
    assert.equal(result.kind, "match");
    if (result.kind === "match") assert.equal(result.slug, "shop");
  });

  it("reports ambiguity when several projects match", () => {
    const duplicated: ProjectsIndex = {
      projects: {
        dup: makeEntry({ path: "/work/one/dup" }),
        "dup-2": makeEntry({ path: "/work/two/dup" }),
      },
    };
    const result = resolveProject(duplicated, "dup");
    assert.equal(result.kind, "ambiguous");
    if (result.kind === "ambiguous") assert.deepEqual([...result.slugs].sort(), ["dup", "dup-2"]);
  });

  it("returns none for empty or unknown queries", () => {
    assert.equal(resolveProject(index, "").kind, "none");
    assert.equal(resolveProject(index, "   ").kind, "none");
    assert.equal(resolveProject(index, "nothing-like-this").kind, "none");
  });
});

describe("requireProject", () => {
  const index: ProjectsIndex = {
    projects: { alpha: makeEntry({ path: "/work/alpha" }) },
  };

  it("returns the matched entry", () => {
    const { slug, entry } = requireProject(index, "alpha");
    assert.equal(slug, "alpha");
    assert.equal(entry.path, "/work/alpha");
  });

  it("throws for an unknown query", () => {
    assert.throws(() => requireProject(index, "nope"), /No project matches 'nope'/);
  });

  it("throws for an ambiguous query", () => {
    const duplicated: ProjectsIndex = {
      projects: {
        dup: makeEntry({ path: "/work/one/dup" }),
        "dup-2": makeEntry({ path: "/work/two/dup" }),
      },
    };
    assert.throws(() => requireProject(duplicated, "dup"), /matches several projects: dup, dup-2/);
  });
});

describe("absoluteArtifacts", () => {
  it("joins every relative artifact against the project path", () => {
    const entry = makeEntry({
      path: "/work/alpha",
      artifacts: {
        memory: ["MEMORY.md", ".agenthome/memory.md"],
        rules: ["AGENTS.md"],
        skills: [".agents/skills"],
        mcp: [".agenthome/mcp.yaml"],
      },
    });
    assert.deepEqual(absoluteArtifacts(entry), {
      memory: ["/work/alpha/MEMORY.md", "/work/alpha/.agenthome/memory.md"],
      rules: ["/work/alpha/AGENTS.md"],
      skills: ["/work/alpha/.agents/skills"],
      mcp: ["/work/alpha/.agenthome/mcp.yaml"],
    });
  });
});

describe("detectArtifacts", () => {
  it("detects known candidates in their canonical order", async () => {
    const sandbox = await createSandbox();
    try {
      await fs.mkdir(path.join(sandbox.project, ".agenthome"), { recursive: true });
      await fs.mkdir(path.join(sandbox.project, ".agents", "skills"), { recursive: true });
      for (const file of [".agenthome/memory.md", "MEMORY.md", "AGENTS.md", "opencode.jsonc"]) {
        await fs.writeFile(path.join(sandbox.project, file), "x\n", "utf8");
      }
      assert.deepEqual(await detectArtifacts(sandbox.project), {
        memory: [".agenthome/memory.md", "MEMORY.md"],
        rules: ["AGENTS.md"],
        skills: [".agents/skills"],
        mcp: ["opencode.jsonc"],
      });
    } finally {
      await sandbox.cleanup();
    }
  });

  it("returns empty lists for a project without artifacts", async () => {
    const sandbox = await createSandbox();
    try {
      assert.deepEqual(await detectArtifacts(sandbox.project), emptyArtifacts());
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe("hasArtifacts", () => {
  it("is false when every artifact list is empty", () => {
    assert.equal(hasArtifacts(makeEntry()), false);
  });

  it("is true when at least one artifact is present", () => {
    const entry = makeEntry({
      artifacts: { ...emptyArtifacts(), rules: ["AGENTS.md"] },
    });
    assert.equal(hasArtifacts(entry), true);
  });
});

describe("registerProject", () => {
  it("writes a canonical entry into $HOME/.agenthome/projects.yaml", async () => {
    await withSandboxHome(async (sandbox) => {
      await fs.writeFile(path.join(sandbox.project, "MEMORY.md"), "# memory\n", "utf8");
      const { slug, entry } = await registerProject(sandbox.project, "opencode");
      const canonical = await fs.realpath(sandbox.project);

      assert.equal(slug, "project");
      assert.equal(entry.path, canonical);
      assert.deepEqual(entry.harnesses, ["opencode"]);
      assert.deepEqual(entry.aliases, []);
      assert.deepEqual(entry.artifacts.memory, ["MEMORY.md"]);
      assert.ok(!Number.isNaN(Date.parse(entry.last_seen)));
      assert.equal(entry.artifacts_changed_at, entry.last_seen);
      assert.equal(entry.artifacts_signature, JSON.stringify(entry.artifacts));
      assert.equal(indexFile(), path.join(sandbox.home, ".agenthome", "projects.yaml"));

      const doc = YAML.parse(await fs.readFile(indexFile(), "utf8")) as { projects: Record<string, ProjectEntry> };
      assert.equal(doc.projects.project?.path, canonical);
      assert.deepEqual(await fs.readdir(path.dirname(indexFile())), ["projects.yaml"]);
    });
  });

  it("merges harnesses, keeps the slug and preserves aliases", async () => {
    await withSandboxHome(async (sandbox) => {
      const first = await registerProject(sandbox.project, "pi");
      const index = await loadIndex();
      index.projects[first.slug]!.aliases = ["kept"];
      await saveIndex(index);

      const second = await registerProject(sandbox.project, "opencode");
      assert.equal(second.slug, first.slug);
      assert.deepEqual(second.entry.harnesses, ["pi", "opencode"]);
      assert.deepEqual(second.entry.aliases, ["kept"]);
      assert.equal(Object.keys((await loadIndex()).projects).length, 1);

      const third = await registerProject(sandbox.project, "pi");
      assert.deepEqual(third.entry.harnesses, ["pi", "opencode"]);
    });
  });

  it("keeps artifacts_changed_at when the artifact signature is unchanged", async () => {
    await withSandboxHome(async (sandbox) => {
      await fs.writeFile(path.join(sandbox.project, "MEMORY.md"), "# memory\n", "utf8");
      const first = await registerProject(sandbox.project, "pi");
      await sleep(25);
      const second = await registerProject(sandbox.project, "opencode");

      assert.equal(second.entry.artifacts_changed_at, first.entry.artifacts_changed_at);
      assert.equal(second.entry.artifacts_signature, first.entry.artifacts_signature);
      assert.ok(second.entry.last_seen > first.entry.last_seen);
    });
  });

  it("bumps artifacts_changed_at when a new artifact appears", async () => {
    await withSandboxHome(async (sandbox) => {
      const first = await registerProject(sandbox.project, "pi");
      assert.equal(first.entry.artifacts_changed_at, first.entry.last_seen);

      await sleep(25);
      await fs.writeFile(path.join(sandbox.project, "MEMORY.md"), "# memory\n", "utf8");
      const second = await registerProject(sandbox.project, "pi");

      assert.ok(second.entry.artifacts_changed_at > first.entry.artifacts_changed_at);
      assert.equal(second.entry.artifacts_changed_at, second.entry.last_seen);
      assert.notEqual(second.entry.artifacts_signature, first.entry.artifacts_signature);
    });
  });

  it("does not report a change for a legacy entry without artifacts_signature", async () => {
    await withSandboxHome(async (sandbox) => {
      const canonical = await fs.realpath(sandbox.project);
      await fs.mkdir(path.join(sandbox.home, ".agenthome"), { recursive: true });
      await fs.writeFile(
        indexFile(),
        YAML.stringify({
          projects: {
            project: {
              path: canonical,
              aliases: ["old"],
              last_seen: "2026-01-02T03:04:05.000Z",
              harnesses: ["pi"],
              artifacts: { memory: ["MEMORY.md"], rules: [], skills: [], mcp: [] },
            },
          },
        }),
        "utf8",
      );
      await fs.writeFile(path.join(sandbox.project, "MEMORY.md"), "# memory\n", "utf8");

      const { entry } = await registerProject(sandbox.project, "opencode");
      assert.equal(entry.artifacts_changed_at, "2026-01-02T03:04:05.000Z");
      assert.equal(entry.artifacts_signature, JSON.stringify(entry.artifacts));
      assert.deepEqual(entry.aliases, ["old"]);
      assert.deepEqual(entry.harnesses, ["pi", "opencode"]);
      assert.ok(entry.last_seen > "2026-01-02T03:04:05.000Z");
    });
  });

  it("suffixes colliding slugs with a counter", async () => {
    await withSandboxHome(async (sandbox) => {
      const other = path.join(sandbox.root, "nested", "project");
      await fs.mkdir(other, { recursive: true });
      const first = await registerProject(sandbox.project, "pi");
      const second = await registerProject(other, "pi");
      assert.equal(first.slug, "project");
      assert.equal(second.slug, "project-2");
      assert.deepEqual(Object.keys((await loadIndex()).projects).sort(), ["project", "project-2"]);
    });
  });

  it("returns an empty index when projects.yaml does not exist", async () => {
    await withSandboxHome(async () => {
      assert.deepEqual(await loadIndex(), { projects: {} });
    });
  });
});
