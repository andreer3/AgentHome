import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { createSandbox } from "../helpers/sandbox.js";
import { MANAGED_HEADER, resolveConfigSlot } from "../../src/adapters/opencode-slots.js";

describe("resolveConfigSlot", () => {
  it("claims a free slot when the file does not exist", async () => {
    const sandbox = await createSandbox();
    try {
      const file = path.join(sandbox.project, "opencode.jsonc");

      const slot = await resolveConfigSlot(file);

      assert.deepEqual(slot, { file, owned: true });
    } finally {
      await sandbox.cleanup();
    }
  });

  it("claims an existing file containing the managed marker", async () => {
    const sandbox = await createSandbox();
    try {
      const file = path.join(sandbox.project, "opencode.jsonc");
      await fs.writeFile(file, `${MANAGED_HEADER}\n{}\n`, "utf8");

      const slot = await resolveConfigSlot(file);

      assert.deepEqual(slot, { file, owned: true });
    } finally {
      await sandbox.cleanup();
    }
  });

  it("throws when the file exists without the managed marker", async () => {
    const sandbox = await createSandbox();
    try {
      const file = path.join(sandbox.project, "opencode.jsonc");
      await fs.writeFile(file, '{ "model": "user/owned" }\n', "utf8");

      await assert.rejects(
        () => resolveConfigSlot(file),
        (error: unknown) => {
          assert.ok(error instanceof Error, "expected an Error instance");
          assert.match(error.message, /not managed by AgentHome/);
          return true;
        },
      );
    } finally {
      await sandbox.cleanup();
    }
  });
});
