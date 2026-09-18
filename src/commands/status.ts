import { adapters } from "../adapters/index.js";
import { exists } from "../core/files.js";
import { globalRoot } from "../core/paths.js";
import path from "node:path";

export async function statusCommand(cwd: string): Promise<void> {
  console.log("AgentHome status\n");
  console.log(`global root: ${globalRoot()}`);
  console.log(`global config: ${(await exists(path.join(globalRoot(), "agenthome.yaml"))) ? "found" : "missing"}`);
  console.log(`project config: ${(await exists(path.join(cwd, ".agenthome.yaml"))) ? "found" : "missing"}`);
  for (const adapter of Object.values(adapters)) {
    console.log(`\n${adapter.name}`);
    for (const line of await adapter.status(cwd)) console.log(`  ${line}`);
  }
}
