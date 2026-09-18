import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeConfig } from "../../src/config/load.js";
import { configSchema, type AgentHomeConfig } from "../../src/config/schema.js";

function parseConfig(input: unknown): AgentHomeConfig {
  return configSchema.parse(input);
}

describe("mergeConfig", () => {
  it("returns the global config with resolved targets when there is no project config", () => {
    const globalConfig = parseConfig({
      version: 1,
      sources: { global: { memory: ["global-memory.md"] } },
      targets: ["opencode"],
    });
    const merged = mergeConfig(globalConfig, null);
    assert.deepEqual(merged, { ...globalConfig, targets: ["opencode"] });
  });

  it("keeps global and project sources in their own groups", () => {
    const globalConfig = parseConfig({
      version: 1,
      sources: { global: { memory: ["global-memory.md"], rules: ["global-rules.md"] } },
    });
    const projectConfig = parseConfig({
      version: 1,
      sources: { project: { rules: ["project-rules.md"], skills: ["project-skill.md"] } },
    });

    const merged = mergeConfig(globalConfig, projectConfig);

    assert.deepEqual(merged.sources.global.memory, ["global-memory.md"]);
    assert.deepEqual(merged.sources.global.rules, ["global-rules.md"]);
    assert.deepEqual(merged.sources.project.rules, ["project-rules.md"]);
    assert.deepEqual(merged.sources.project.skills, ["project-skill.md"]);
    assert.deepEqual(merged.sources.project.memory, []);
  });

  it("prefers project values and falls back to global ones", () => {
    const globalConfig = parseConfig({
      version: 1,
      sources: {},
      mcpRegistry: "global-mcp.yaml",
      providersFile: "global-providers.yaml",
    });
    const projectConfig = parseConfig({
      version: 1,
      sources: {},
      mcpRegistry: "project-mcp.yaml",
    });

    const merged = mergeConfig(globalConfig, projectConfig);

    assert.equal(merged.mcpRegistry, "project-mcp.yaml");
    assert.equal(merged.providersFile, "global-providers.yaml");
  });

  it("falls back to the global targets when the project does not declare targets", () => {
    const globalConfig = parseConfig({ version: 1, sources: {}, targets: ["opencode"] });
    const projectConfig = parseConfig({ version: 1, sources: {} });

    assert.equal(projectConfig.targets, undefined);
    assert.deepEqual(mergeConfig(globalConfig, projectConfig).targets, ["opencode"]);
  });

  it("defaults targets to opencode and pi when neither scope declares them", () => {
    const globalConfig = parseConfig({ version: 1, sources: {} });
    const projectConfig = parseConfig({ version: 1, sources: {} });

    assert.deepEqual(mergeConfig(globalConfig, projectConfig).targets, ["opencode", "pi"]);
  });

  it("uses explicit project targets when declared", () => {
    const globalConfig = parseConfig({ version: 1, sources: {}, targets: ["opencode", "pi"] });
    const projectConfig = parseConfig({ version: 1, sources: {}, targets: ["pi"] });

    assert.deepEqual(mergeConfig(globalConfig, projectConfig).targets, ["pi"]);
  });
});
