import path from "node:path";
import { pathToFileURL } from "node:url";

const [hookPath, harness, projectPath] = process.argv.slice(2);
if (!hookPath || !harness || !projectPath) {
  console.error("usage: run-hook.mjs <hookPath> <harness> <projectPath>");
  process.exit(2);
}

const mod = await import(pathToFileURL(path.resolve(hookPath)).href);

if (harness === "pi") {
  const handlers = {};
  await mod.default({ on: (name, fn) => { handlers[name] = fn; } });
  await handlers.session_start({ reason: "startup" }, { cwd: projectPath });
} else if (harness === "opencode") {
  const hooks = await mod.AgentHomeRegister({ directory: projectPath });
  await hooks?.event?.({ event: { type: "session.created", properties: { info: { directory: projectPath } } } });
} else {
  console.error(`unsupported harness: ${harness}`);
  process.exit(2);
}

setTimeout(() => { process.exit(0); }, 1000);
