---
name: agenthome-adapter
description: Add support for a new AI coding harness to AgentHome. Use when implementing a new adapter, its tests, or its documentation.
---

# Adding a harness adapter

AgentHome keeps the core harness-neutral: every harness-specific detail lives in an adapter.

## Steps

1. Implement `HarnessAdapter` in `src/adapters/<harness>.ts`:
   - `detect()`: is the harness installed?
   - `status(cwd)`: human-readable location of its config files.
   - `plan(ctx)`: add intended writes to `ctx.plan`; never write to disk directly.
2. Respect the safety rules:
   - Rules/memory belong in managed blocks (`planManagedBlock`) or the harness's own "instructions" mechanism.
   - JSON/JSONC keys use `planJsoncProperties`. If AgentHome owns the file (marker header), pass `owned: true`; otherwise conflicting keys are skipped and reported.
   - Never edit a user-owned file at the highest-precedence slot: fail with migration guidance instead.
3. Register the adapter in `src/adapters/index.ts` and add its name to `configSchema.targets` and `mcpServerSchema.targets` in `src/config/schema.ts`.
4. Scope: emit global servers (`ctx.mcpGlobal`) only for `--scope global` and project servers (`ctx.mcpProject`) only for `--scope project`.
5. Tests: add `test/e2e/<harness>.test.ts` using `test/helpers/sandbox.ts` (isolated HOME). Assert config contents, idempotency and that the real HOME is untouched.
6. Docs: update the targets list in `README.md` and the roadmap in `AGENTHOME_PLAN.md`.

## Verify

```bash
npm run typecheck
npm run build
npm test
```
