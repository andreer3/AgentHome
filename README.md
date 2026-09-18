# AgentHome

> Configure your agent environment once. Use it everywhere.

**Status:** Phase 1 complete / `v0.1.0` — working prototype, not production-ready.

AgentHome is a portable configuration layer for AI coding harnesses. It does **not** replace OpenCode, Pi, Codex, Claude Code, or other harnesses. It keeps durable agent configuration in a harness-neutral form and compiles it into supported targets.

## Phase 1 targets

- OpenCode
- Pi

## Phase 1 primitives

- global + project memory
- global + project rules
- portable Agent Skills directories (`~/.agents/skills` and `.agents/skills`)
- MCP registry
- portable default provider/model

## Commands

```bash
npm install
npm run build
npm test
npm link

agenthome init [--project <dir>] [--home <dir>]
agenthome status
agenthome doctor
agenthome apply opencode --scope project --dry-run
agenthome apply opencode --scope project
agenthome apply pi --scope project
agenthome import opencode --dry-run
agenthome import opencode
```

`init` never overwrites existing AgentHome source files. On the first `init`, AgentHome **adopts** the existing global OpenCode `mcp` servers and `model` into its canonical files before it starts taking precedence. OpenCode integration is **non-destructive**: `apply opencode` writes AgentHome's own managed `opencode.jsonc` (marked with `@agenthome-managed`) and never edits your `opencode.json`. Rules are injected through OpenCode's `instructions` key pointing at AgentHome's canonical files, so your `AGENTS.md` stays untouched and is still loaded by OpenCode. Because OpenCode loads `opencode.jsonc` after `opencode.json`, AgentHome's values win per key within the same scope; a project config still wins over AgentHome's global file. Pi keeps using managed blocks inside `AGENTS.md` plus `.pi/settings.json` / `.pi/mcp.json`.

Safety: `apply` is idempotent and `--dry-run` prints the plan without writing. Existing top-level keys whose value differs are not replaced unless `--force` is passed: conflicting keys are reported as skipped, the rest is still applied, and the command exits with code 1. AgentHome only writes its own managed `opencode.jsonc`; if that file already exists and is yours, `apply` fails with migration guidance instead of touching it. `--home` redirects global AgentHome files (the test suite uses isolated temp HOMEs; the real HOME is never touched).

## Current layout

```text
~/.agenthome/
├── agenthome.yaml
├── memory/global.md
├── rules/global.md
├── mcp/registry.yaml
└── providers/providers.yaml

~/.agents/skills/

project/
├── .agenthome.yaml
├── .agenthome/
│   ├── memory.md
│   └── rules.md
└── .agents/skills/
```

Both OpenCode and Pi currently discover `.agents/skills`, so AgentHome deliberately uses that shared convention instead of copying skills into harness-specific directories.

## MCP scopes

MCP servers live in two registries:

- global: `~/.agenthome/mcp/registry.yaml`, compiled by `apply --scope global` into the global harness config;
- project: `<project>/.agenthome/mcp.yaml`, compiled by `apply --scope project` into the project harness config.

They are not duplicated across scopes. OpenCode and `pi-mcp-extension` both merge global + project configuration (project wins per server name), so a project only carries its own extras. `doctor` warns when the same name is defined in both scopes with different content, and when a disabled server will be skipped for Pi.

## Project index and routing

AgentHome keeps a map of the projects where your agent memory/skills live, in `~/.agenthome/projects.yaml` (paths and metadata only, never contents). Projects are registered automatically when OpenCode or Pi starts in them: `apply <target> --scope global` installs a small managed hook (`~/.config/opencode/plugins/agenthome-register.ts` and `~/.pi/agent/extensions/agenthome-register.ts`) that calls `agenthome register` in the background. It also installs a first-class router tool (`agenthome-route` in OpenCode, `agenthome_route` in Pi) so the model resolves cross-project memory by calling AgentHome instead of guessing paths.

```bash
agenthome register --path <dir> --harness opencode   # used by the hooks
agenthome projects list [--all] [--json]
agenthome projects show <query> [--json]
agenthome projects alias <query> <alias...>
agenthome projects remove <query>
agenthome route <query> [--json]   # absolute paths of memory/rules/skills/mcp
agenthome summary [--json]
```

`route` is how the AI model finds another project's memory: AgentHome serves the paths, the model reads them on demand, and nothing is copied into the global memory. Add `agenthome summary` to your `/salud` command to see the map.

`projects list` shows only projects that actually have memory/rules/skills; `--all` includes the rest. Each entry tracks `last_seen` (when a harness started there) separately from `artifacts_changed_at` (when its memory/rules/skills actually changed, detected by content signature), so `summary` reports real changes instead of every terminal launch.

## Skills

AgentHome does not copy skills into harness-specific directories: OpenCode and Pi both discover the shared Agent Skills convention (`~/.agents/skills` and `<project>/.agents/skills`). An example skill lives in `examples/skills/agenthome-adapter/SKILL.md`; copy its folder into either skills directory to use it.

## Pi MCP note

Pi's core is intentionally minimal. Phase 1 compiles MCP configuration to the format used by the community `pi-mcp-extension`. Install it separately before expecting generated `mcp.json` files to load:

```bash
pi install npm:pi-mcp-extension
```

AgentHome does not silently install third-party executable extensions. Remote `headers` are mapped to the extension format; servers with `enabled: false` are skipped for Pi because the extension has no such field. Known upstream caveats: the extension hardcodes the global path (it ignores `PI_CODING_AGENT_DIR`), and a project `.pi/mcp.json` without a `settings` block resets the global MCP settings.

## Importing an existing OpenCode setup

`agenthome import opencode` reads your existing `opencode.json`/`opencode.jsonc` (global by default, `--scope project` for the project one), adopts its `mcp` servers and `model` into `~/.agenthome/mcp/registry.yaml` and `~/.agenthome/providers/providers.yaml`, and leaves the originals untouched. `init` runs this adoption automatically on first installation. Existing AgentHome entries are kept unless `--force`; clashes and invalid entries are reported (a `model` without `provider/model` is reported as invalid and skipped). Use `--dry-run` to preview.

## Safety / alpha limitations

- `--dry-run` and the conflict guard are implemented; automatic backups, unified diff and `--check` are still pending (Phase 3).
- `--force` replaces whole top-level keys including their nested entries, but only in files AgentHome owns (or explicitly targeted Pi settings). Use `agenthome import opencode` to adopt existing servers/model into the canonical registry.
- Pi remote MCP headers are not mapped yet.
- Provider support currently means a portable **default provider/model**, not arbitrary vendor-specific provider schemas.
- Secret management is out of scope for Phase 1. Do not put API keys in AgentHome YAML.

See `AGENTHOME_PLAN.md` for the phased roadmap.
