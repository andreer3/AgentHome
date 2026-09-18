import type { McpRegistry, ProvidersConfig, ResolvedConfig } from "../config/schema.js";
import type { ApplyPlan } from "../core/plan.js";

export type ApplyScope = "global" | "project" | "all";

export interface ApplyContext {
  cwd: string;
  config: ResolvedConfig;
  /** MCP servers from the global registry (`~/.agenthome/mcp/registry.yaml`). */
  mcpGlobal: McpRegistry;
  /** MCP servers from the project registry (`.agenthome/mcp.yaml`). */
  mcpProject: McpRegistry;
  providers: ProvidersConfig;
  scope: ApplyScope;
  plan: ApplyPlan;
  force: boolean;
}

export interface HarnessAdapter {
  name: "opencode" | "pi";
  detect(): Promise<boolean>;
  plan(ctx: ApplyContext): Promise<void>;
  status(cwd: string): Promise<string[]>;
}
