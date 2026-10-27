// Render every formula of a built site with KaTeX and report parse errors
// (KaTeX in the browser would otherwise show them in red).
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import katex from "katex";
import { unescapeHtml } from "./util.js";

function htmlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "pagefind" && entry.name !== "assets") out.push(...htmlFiles(p));
    } else if (entry.name.endsWith(".html")) out.push(p);
  }
  return out;
}

export function checkMath(siteDir: string): { formulas: number; failures: string[] } {
  let formulas = 0;
  const failures: string[] = [];
  for (const file of htmlFiles(siteDir)) {
    const html = readFileSync(file, "utf8");
    const mm = /window\.KATEX_MACROS = (\{.*?\});<\/script>/.exec(html);
    const macros: Record<string, string> = mm ? JSON.parse(mm[1].replace(/<\\\//g, "</")) : {};
    for (const m of html.matchAll(/<span class="math (inline|display)">([\s\S]*?)<\/span>/g)) {
      formulas++;
      const tex = unescapeHtml(m[2]);
      try {
        katex.renderToString(tex, { displayMode: m[1] === "display", macros: { ...macros }, throwOnError: true, strict: "ignore" });
      } catch (e) {
        failures.push(`${relative(siteDir, file)}: ${String((e as Error).message).split("\n")[0]}\n    ${tex.slice(0, 160)}`);
      }
    }
  }
  return { formulas, failures };
}
