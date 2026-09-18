#!/usr/bin/env node
import path from "node:path";
import { Command, Option } from "commander";
import { initCommand } from "./commands/init.js";
import { statusCommand } from "./commands/status.js";
import { doctorCommand } from "./commands/doctor.js";
import { applyCommand } from "./commands/apply.js";
import { importCommand } from "./commands/import.js";
import { registerCommand } from "./commands/register.js";
import { projectsAliasCommand, projectsListCommand, projectsRemoveCommand, projectsShowCommand } from "./commands/projects.js";
import { routeCommand } from "./commands/route.js";
import { summaryCommand } from "./commands/summary.js";

interface CommonOptions {
  project: string;
  home?: string;
}

interface HomeOptions {
  home?: string;
}

function withCommonOptions(command: Command): Command {
  return command
    .addOption(new Option("--project <dir>", "project directory to operate on").default(process.cwd()))
    .addOption(new Option("--home <dir>", "home directory for global AgentHome files (default: $HOME)"));
}

function withHomeOption(command: Command): Command {
  return command.addOption(new Option("--home <dir>", "home directory for AgentHome files (default: $HOME)"));
}

function resolveContext(options: CommonOptions): string {
  if (options.home) process.env.HOME = path.resolve(options.home);
  return path.resolve(options.project);
}

function applyHome(options: HomeOptions): void {
  if (options.home) process.env.HOME = path.resolve(options.home);
}

const program = new Command();
program
  .name("agenthome")
  .description("Portable configuration layer for AI coding harnesses")
  .version("0.1.0");

withCommonOptions(program.command("init"))
  .description("Initialize global and project AgentHome files without overwriting existing files")
  .option("--scope <scope>", "global, project, or all", "all")
  .action(async (options: CommonOptions & { scope: string }) => {
    if (!["global", "project", "all"].includes(options.scope)) throw new Error("scope must be global, project, or all");
    await initCommand(resolveContext(options), { scope: options.scope as "global" | "project" | "all" });
  });

withCommonOptions(program.command("status"))
  .description("Show AgentHome and harness detection status")
  .action(async (options: CommonOptions) => statusCommand(resolveContext(options)));

withCommonOptions(program.command("doctor"))
  .description("Validate config and report missing/incompatible resources")
  .action(async (options: CommonOptions) => doctorCommand(resolveContext(options)));

withCommonOptions(program.command("apply"))
  .description("Compile AgentHome configuration into a harness")
  .argument("<target>", "opencode or pi")
  .option("--scope <scope>", "global, project, or all", "project")
  .option("--dry-run", "show planned changes without writing anything")
  .option("--force", "replace existing conflicting configuration")
  .action(
    async (
      target: string,
      options: CommonOptions & { scope: string; dryRun: boolean; force: boolean },
    ) => {
      if (target !== "opencode" && target !== "pi") throw new Error("target must be 'opencode' or 'pi'");
      if (!["global", "project", "all"].includes(options.scope)) throw new Error("scope must be global, project, or all");
      await applyCommand(target, resolveContext(options), {
        scope: options.scope as "global" | "project" | "all",
        dryRun: options.dryRun,
        force: options.force,
      });
    },
  );

withCommonOptions(program.command("import"))
  .description("Import existing harness configuration into AgentHome")
  .argument("<target>", "opencode")
  .option("--scope <scope>", "global or project", "global")
  .option("--dry-run", "show what would be imported without writing")
  .option("--force", "replace existing AgentHome entries")
  .action(
    async (
      target: string,
      options: CommonOptions & { scope: string; dryRun: boolean; force: boolean },
    ) => {
      if (!["global", "project"].includes(options.scope)) throw new Error("scope must be global or project");
      await importCommand(target, resolveContext(options), {
        scope: options.scope as "global" | "project",
        dryRun: options.dryRun,
        force: options.force,
      });
    },
  );

withHomeOption(program.command("register"))
  .description("Register a project in AgentHome's index (called by the harness hooks)")
  .option("--path <dir>", "project directory", process.cwd())
  .option("--harness <name>", "harness that started (opencode, pi, ...)", "unknown")
  .option("--verbose", "print the registered entry")
  .action(async (options: HomeOptions & { path: string; harness: string; verbose?: boolean }) => {
    applyHome(options);
    await registerCommand({ path: options.path, harness: options.harness, verbose: options.verbose });
  });

const projectsCommand = program.command("projects").description("Manage AgentHome's project index (paths only, never contents)");

withHomeOption(projectsCommand.command("list"))
  .description("List indexed projects (only those with memory/rules/skills by default)")
  .option("--all", "include projects without artifacts")
  .option("--json", "print JSON")
  .action(async (options: HomeOptions & { all?: boolean; json?: boolean }) => {
    applyHome(options);
    await projectsListCommand({ all: options.all, json: options.json });
  });

withHomeOption(projectsCommand.command("show"))
  .description("Show one indexed project")
  .argument("<query>", "slug, alias, name or path")
  .option("--json", "print JSON")
  .action(async (query: string, options: HomeOptions & { json?: boolean }) => {
    applyHome(options);
    await projectsShowCommand(query, { json: options.json });
  });

withHomeOption(projectsCommand.command("alias"))
  .description("Add aliases/keywords to a project")
  .argument("<query>", "slug, alias, name or path")
  .argument("<alias...>", "one or more aliases")
  .action(async (query: string, aliases: string[], options: HomeOptions) => {
    applyHome(options);
    await projectsAliasCommand(query, aliases);
  });

withHomeOption(projectsCommand.command("remove"))
  .description("Remove a project from the index (project files are not touched)")
  .argument("<query>", "slug, alias, name or path")
  .action(async (query: string, options: HomeOptions) => {
    applyHome(options);
    await projectsRemoveCommand(query);
  });

withHomeOption(program.command("route"))
  .description("Resolve a project keyword to the paths of its memory/rules/skills/mcp")
  .argument("<query>", "slug, alias, name or path")
  .option("--json", "print JSON (for programmatic use)")
  .action(async (query: string, options: HomeOptions & { json?: boolean }) => {
    applyHome(options);
    await routeCommand(query, { json: options.json });
  });

withHomeOption(program.command("summary"))
  .description("Short summary of the indexed projects")
  .option("--json", "print JSON")
  .action(async (options: HomeOptions & { json?: boolean }) => {
    applyHome(options);
    await summaryCommand({ json: options.json });
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
