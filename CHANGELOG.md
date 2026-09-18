# Changelog

## v0.1.0 — Phase 1 complete

Portable configuration layer for OpenCode and Pi (`agenthome` CLI).

### Added

- Commands: `init`, `status`, `doctor`, `apply <target>`, `import opencode`.
- Global and project memory/rules: OpenCode via `instructions`, Pi via managed blocks in `AGENTS.md`.
- MCP registries per scope: global `~/.agenthome/mcp/registry.yaml`, project `<project>/.agenthome/mcp.yaml`; compiled to OpenCode and `pi-mcp-extension` formats.
- Portable default provider/model.
- Non-destructive OpenCode integration: AgentHome writes its own managed `opencode.jsonc` and never edits the user's `opencode.json`/`AGENTS.md`.
- First-installation adoption of an existing OpenCode `mcp`/`model`; `agenthome import opencode [--scope global|project] [--dry-run] [--force]`.
- `agenthome apply --dry-run`, partial-apply conflict reporting and `--force` replacement.
- `--project`/`--home` isolation flags.
- Project index and routing: `register`, `projects list|show|alias|remove`, `route`, `summary`; project map at `~/.agenthome/projects.yaml` (paths only). `last_seen` and `artifacts_changed_at` are tracked separately, and `projects list` hides projects without artifacts unless `--all` is passed.
- Auto-registration hooks installed by `apply --scope global`: OpenCode plugin (`~/.config/opencode/plugins/agenthome-register.ts`) and Pi extension (`~/.pi/agent/extensions/agenthome-register.ts`), both managed and fail-safe.
- First-class router tools so models route instead of guessing paths: `agenthome-route` (OpenCode custom tool) and `agenthome_route` (Pi extension tool).
- 120 tests (unit + E2E with isolated temp HOMEs); GitHub Actions CI for Node 22 and 24.
- Example portable skill: `examples/skills/agenthome-adapter/SKILL.md`.

### Known limitations

- Automatic backups, unified diff and `--check` are planned for Phase 3.
- Pi MCP requires the community `pi-mcp-extension`.
- Secret management is out of scope until Phase 8.
