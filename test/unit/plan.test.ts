import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { parse as parseJsonc } from "jsonc-parser";
import { createSandbox } from "../helpers/sandbox.js";
import {
  ApplyPlan,
  buildJsoncProperties,
  buildManagedBlock,
  planJsoncProperties,
  planManagedBlock,
  renderPlan,
} from "../../src/core/plan.js";

const ID = "demo";
const START = `<!-- agenthome:${ID}:start -->`;
const END = `<!-- agenthome:${ID}:end -->`;

describe("buildManagedBlock", () => {
  it("creates a block in empty content", () => {
    const result = buildManagedBlock("", ID, "hello");
    assert.equal(result, `${START}\nhello\n${END}\n`);
  });

  it("updates an existing block preserving text before and after", () => {
    const current = `before\n\n${START}\nold body\n${END}\n\nafter\n`;
    const result = buildManagedBlock(current, ID, "new body");
    assert.equal(result, `before\n\n${START}\nnew body\n${END}\n\nafter\n`);
  });

  it("is idempotent for the same body", () => {
    const once = buildManagedBlock("", ID, "same body");
    const twice = buildManagedBlock(once, ID, "same body");
    assert.equal(twice, once);
  });

  it("returns the current content unchanged for empty or whitespace-only bodies", () => {
    const current = `keep me\n`;
    assert.equal(buildManagedBlock(current, ID, ""), current);
    assert.equal(buildManagedBlock(current, ID, "   \n\t "), current);
  });

  it("strips an orphan end marker and appends a single block", () => {
    const current = `text\n${END}\n`;
    const result = buildManagedBlock(current, ID, "body");
    assert.equal(result, `text\n\n${START}\nbody\n${END}\n`);
    assert.equal(result.split(START).length - 1, 1);
    assert.equal(result.split(END).length - 1, 1);
  });

  it("normalizes end before start into a single block", () => {
    const current = `${END}\n${START}\n`;
    const result = buildManagedBlock(current, ID, "body");
    assert.equal(result, `${START}\nbody\n${END}\n`);
    assert.equal(result.split(START).length - 1, 1);
    assert.equal(result.split(END).length - 1, 1);
  });

  it("collapses duplicate complete blocks into a single block", () => {
    const current = `intro\n\n${START}\nold\n${END}\n\n${START}\nstale\n${END}\n`;
    const result = buildManagedBlock(current, ID, "body");
    assert.equal(result.split(START).length - 1, 1);
    assert.equal(result.split(END).length - 1, 1);
    assert.match(result, /intro/);
    assert.doesNotMatch(result, /stale/);
  });
});

describe("buildJsoncProperties", () => {
  const file = "config.json";

  it("creates content from empty string and ends with a newline", () => {
    const { content, conflicts } = buildJsoncProperties("", file, { theme: "dark" }, { force: false });
    assert.deepEqual(conflicts, []);
    assert.equal(content.endsWith("\n"), true);
    assert.deepEqual(JSON.parse(content), { theme: "dark" });
  });

  it("preserves foreign keys and comments", () => {
    const current = `{\n  // keep me\n  "existing": true\n}\n`;
    const { content, conflicts } = buildJsoncProperties(current, file, { added: 1 }, { force: false });
    assert.deepEqual(conflicts, []);
    assert.ok(content.includes("// keep me"));
    assert.deepEqual(parseJsonc(content), { existing: true, added: 1 });
  });

  it("is idempotent", () => {
    const properties = { a: 1, nested: { x: true } };
    const first = buildJsoncProperties("", file, properties, { force: false });
    const second = buildJsoncProperties(first.content, file, properties, { force: false });
    assert.deepEqual(second.conflicts, []);
    assert.equal(second.content, first.content);
  });

  it("reports one conflict and keeps the existing value when force is false", () => {
    const current = `{\n  "a": 1\n}\n`;
    const { content, conflicts } = buildJsoncProperties(current, file, { a: 2 }, { force: false });
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]?.file, file);
    assert.equal(conflicts[0]?.key, "a");
    assert.deepEqual(JSON.parse(content), { a: 1 });
  });

  it("does not conflict for deeply equal values with a different key order", () => {
    const current = `{\n  "obj": { "a": 1, "b": 2 }\n}\n`;
    const { conflicts } = buildJsoncProperties(current, file, { obj: { b: 2, a: 1 } }, { force: false });
    assert.deepEqual(conflicts, []);
  });

  it("replaces the value without conflicts when force is true", () => {
    const current = `{\n  "a": 1\n}\n`;
    const { content, conflicts } = buildJsoncProperties(current, file, { a: 2 }, { force: true });
    assert.deepEqual(conflicts, []);
    assert.deepEqual(JSON.parse(content), { a: 2 });
  });

  it("throws on invalid JSON/JSONC", () => {
    assert.throws(
      () => buildJsoncProperties(`{ "a": }`, file, { b: 1 }, { force: false }),
      /invalid JSON/i,
    );
  });

  it("throws when the root is not an object", () => {
    assert.throws(() => buildJsoncProperties("[]", file, { a: 1 }, { force: false }), /not an object/);
  });
});

describe("ApplyPlan", () => {
  it("keeps a single change with the latest after when the same file is added twice", () => {
    const plan = new ApplyPlan();
    plan.add("/tmp/file", null, "one");
    plan.add("/tmp/file", null, "two");
    assert.equal(plan.changes.length, 1);
    assert.equal(plan.changes[0]?.after, "two");
    assert.equal(plan.changes[0]?.before, null);
    assert.equal(plan.changes[0]?.kind, "create");
  });

  it("excludes changes where before equals after", () => {
    const plan = new ApplyPlan();
    plan.add("/tmp/same", "same", "same");
    assert.deepEqual(plan.changes, []);
    plan.add("/tmp/other", null, "new");
    assert.equal(plan.changes.length, 1);
  });

  it("commit() writes to disk and returns the written paths", async () => {
    const sandbox = await createSandbox();
    try {
      const created = path.join(sandbox.project, "nested", "created.txt");
      const updated = path.join(sandbox.project, "updated.txt");
      await fs.writeFile(updated, "old\n", "utf8");

      const plan = new ApplyPlan();
      plan.add(created, null, "created\n");
      plan.add(updated, "old\n", "new\n");

      const changed = await plan.commit();

      assert.deepEqual(changed, [created, updated]);
      assert.equal(await fs.readFile(created, "utf8"), "created\n");
      assert.equal(await fs.readFile(updated, "utf8"), "new\n");
    } finally {
      await sandbox.cleanup();
    }
  });

  it("renderPlan includes no changes, planned changes and conflicts", () => {
    assert.equal(renderPlan(new ApplyPlan()), "No changes.");

    const planned = new ApplyPlan();
    planned.add("/tmp/created", null, "content");
    planned.add("/tmp/updated", "old", "new");
    const rendered = renderPlan(planned);
    assert.match(rendered, /Planned changes:/);
    assert.match(rendered, /\+ \/tmp\/created/);
    assert.match(rendered, /~ \/tmp\/updated/);

    planned.conflicts.push({ file: "/tmp/created", key: "k", detail: "'k' already exists" });
    const withConflicts = renderPlan(planned);
    assert.match(withConflicts, /Conflicts/);
    assert.match(withConflicts, /! \/tmp\/created: 'k' already exists/);
  });
});

describe("planJsoncProperties / planManagedBlock", () => {
  it("planJsoncProperties records the conflict and plans no change when every key conflicts", async () => {
    const sandbox = await createSandbox();
    try {
      const file = path.join(sandbox.project, "config.json");
      await fs.writeFile(file, `{\n  "a": 1\n}\n`, "utf8");

      const plan = new ApplyPlan();
      await planJsoncProperties(plan, file, { a: 2 }, { force: false });

      assert.equal(plan.conflicts.length, 1);
      assert.equal(plan.conflicts[0]?.key, "a");
      assert.deepEqual(plan.changes, []);
    } finally {
      await sandbox.cleanup();
    }
  });

  it("planJsoncProperties applies non-conflicting keys and skips conflicting ones", async () => {
    const sandbox = await createSandbox();
    try {
      const file = path.join(sandbox.project, "config.json");
      await fs.writeFile(file, `{\n  "a": 1\n}\n`, "utf8");

      const plan = new ApplyPlan();
      await planJsoncProperties(plan, file, { a: 2, b: 3 }, { force: false });

      assert.equal(plan.conflicts.length, 1);
      assert.equal(plan.conflicts[0]?.key, "a");
      assert.equal(plan.changes.length, 1);
      assert.deepEqual(JSON.parse(plan.changes[0]?.after ?? ""), { a: 1, b: 3 });
    } finally {
      await sandbox.cleanup();
    }
  });

  it("planJsoncProperties plans the change when force is true", async () => {
    const sandbox = await createSandbox();
    try {
      const file = path.join(sandbox.project, "config.json");
      await fs.writeFile(file, `{\n  "a": 1\n}\n`, "utf8");

      const plan = new ApplyPlan();
      await planJsoncProperties(plan, file, { a: 2 }, { force: true });

      assert.deepEqual(plan.conflicts, []);
      assert.equal(plan.changes.length, 1);
      assert.deepEqual(JSON.parse(plan.changes[0]?.after ?? ""), { a: 2 });
    } finally {
      await sandbox.cleanup();
    }
  });

  it("planManagedBlock plans nothing for an empty or whitespace-only body", async () => {
    const sandbox = await createSandbox();
    try {
      const file = path.join(sandbox.project, "AGENTS.md");
      const plan = new ApplyPlan();
      await planManagedBlock(plan, file, ID, "   \n\t");
      await planManagedBlock(plan, file, ID, "");
      assert.deepEqual(plan.changes, []);
    } finally {
      await sandbox.cleanup();
    }
  });

  it("planManagedBlock plans a create for a real body", async () => {
    const sandbox = await createSandbox();
    try {
      const file = path.join(sandbox.project, "AGENTS.md");
      const plan = new ApplyPlan();
      await planManagedBlock(plan, file, ID, "managed rules");

      assert.equal(plan.changes.length, 1);
      assert.equal(plan.changes[0]?.kind, "create");
      assert.equal(plan.changes[0]?.after, `${START}\nmanaged rules\n${END}\n`);
    } finally {
      await sandbox.cleanup();
    }
  });
});
