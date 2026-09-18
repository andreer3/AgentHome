import { exists, readText } from "./files.js";
import { resolveSourcePath } from "./paths.js";

export async function compileMarkdownSources(paths: string[], cwd: string, heading: string): Promise<string> {
  const chunks: string[] = [];
  for (const source of paths) {
    const file = resolveSourcePath(source, cwd);
    if (!(await exists(file))) continue;
    const content = (await readText(file)).trim();
    if (!content) continue;
    chunks.push(`## ${heading}: ${source}\n\n${content}`);
  }
  return chunks.join("\n\n");
}
