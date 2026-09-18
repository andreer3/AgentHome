import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { compileMarkdownSources } from "../../src/core/compile.js";
import { expandHome, resolveSourcePath } from "../../src/core/paths.js";
import { createSandbox } from "../helpers/sandbox.js";

describe("expandHome", () => {
  it("expands ~ to the home directory", () => {
    assert.equal(expandHome("~"), os.homedir());
  });

  it("expands ~/x below the home directory", () => {
    assert.equal(expandHome("~/x"), path.join(os.homedir(), "x"));
  });

  it("leaves other paths untouched", () => {
    assert.equal(expandHome("/absolute/x"), "/absolute/x");
    assert.equal(expandHome("relative/x"), "relative/x");
  });
});

describe("resolveSourcePath", () => {
  it("resolves relative paths against cwd", () => {
    assert.equal(resolveSourcePath("docs/a.md", "/base/cwd"), path.resolve("/base/cwd", "docs/a.md"));
  });

  it("keeps absolute paths", () => {
    assert.equal(resolveSourcePath("/abs/a.md", "/base/cwd"), "/abs/a.md");
  });

  it("expands home-relative paths", () => {
    assert.equal(resolveSourcePath("~/a.md", "/base/cwd"), path.join(os.homedir(), "a.md"));
  });
});

describe("compileMarkdownSources", () => {
  it("returns an empty string when there are no sources", async () => {
    const sandbox = await createSandbox();
    try {
      assert.equal(await compileMarkdownSources([], sandbox.project, "Memory"), "");
    } finally {
      await sandbox.cleanup();
    }
  });

  it("ignores missing sources and empty files", async () => {
    const sandbox = await createSandbox();
    try {
      await fs.writeFile(path.join(sandbox.project, "empty.md"), "  \n", "utf8");
      const result = await compileMarkdownSources(["missing.md", "empty.md"], sandbox.project, "Memory");
      assert.equal(result, "");
    } finally {
      await sandbox.cleanup();
    }
  });

  it("respects source order and includes headings", async () => {
    const sandbox = await createSandbox();
    try {
      await fs.writeFile(path.join(sandbox.project, "a.md"), "AAA\n", "utf8");
      await fs.writeFile(path.join(sandbox.project, "b.md"), "BBB\n", "utf8");

      const result = await compileMarkdownSources(["b.md", "a.md"], sandbox.project, "Rules");

      assert.equal(result, "## Rules: b.md\n\nBBB\n\n## Rules: a.md\n\nAAA");
      assert.ok(result.indexOf("b.md") < result.indexOf("a.md"));
    } finally {
      await sandbox.cleanup();
    }
  });
});
