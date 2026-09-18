import path from "node:path";
import { pathToFileURL } from "node:url";

const [toolPath, query] = process.argv.slice(2);
if (!toolPath || query === undefined) {
  console.error("usage: call-tool.mjs <toolPath> <query>");
  process.exit(2);
}

const mod = await import(pathToFileURL(path.resolve(toolPath)).href);

let captured;
await mod.default({ registerTool: (def) => { captured = def; } });
if (captured?.name !== "agenthome_route") {
  console.error(`unexpected tool name: ${String(captured?.name)}`);
  process.exit(3);
}

const result = await captured.execute("call-1", { query });
process.stdout.write(String(result?.content?.[0]?.text ?? ""));
