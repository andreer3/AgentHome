import { z } from "zod";

export const sourceGroupSchema = z.object({
  memory: z.array(z.string()).default([]),
  rules: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
});

export const DEFAULT_TARGETS = ["opencode", "pi"] as const;
export type Target = (typeof DEFAULT_TARGETS)[number];

export const configSchema = z.object({
  version: z.literal(1),
  sources: z.object({
    global: sourceGroupSchema.default({ memory: [], rules: [], skills: [] }),
    project: sourceGroupSchema.default({ memory: [], rules: [], skills: [] }),
  }),
  mcpRegistry: z.string().optional(),
  providersFile: z.string().optional(),
  targets: z.array(z.enum(["opencode", "pi"])).optional(),
});

export const mcpServerSchema = z.object({
  type: z.enum(["local", "remote"]),
  command: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  environment: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().default(true),
  lifecycle: z.enum(["eager", "lazy"]).default("lazy"),
  targets: z.array(z.enum(["opencode", "pi"])).optional(),
}).superRefine((value, ctx) => {
  if (value.type === "local" && (!value.command || value.command.length === 0)) {
    ctx.addIssue({ code: "custom", message: "Local MCP servers require command[]" });
  }
  if (value.type === "remote" && !value.url) {
    ctx.addIssue({ code: "custom", message: "Remote MCP servers require url" });
  }
});

export const mcpRegistrySchema = z.object({
  servers: z.record(z.string(), mcpServerSchema).default({}),
});

export const providersSchema = z.object({
  defaults: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
  }).optional(),
});

export type AgentHomeConfig = z.infer<typeof configSchema>;
/** Config with every optional field resolved (used after global+project merge). */
export type ResolvedConfig = Omit<AgentHomeConfig, "targets"> & { targets: Target[] };
export type McpRegistry = z.infer<typeof mcpRegistrySchema>;
export type ProvidersConfig = z.infer<typeof providersSchema>;
