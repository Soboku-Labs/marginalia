// LaTeX books: preamble handling for pandoc and KaTeX, TikZ pictures as SVG.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./util.js";

/** Index just past the balanced group starting at text[i]. */
export function skipGroup(text: string, i: number, open = "{", close = "}"): number {
  let depth = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") { i += 2; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return i;
}

/** Delete every \name[opt]{arg1}...{argN}. */
export function removeCommand(text: string, name: string, nargs: number): string {
  const re = new RegExp("\\\\" + name + "(?![A-Za-z])", "g");
  let out = "";
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out += text.slice(pos, m.index);
    let i = m.index + m[0].length;
    for (let n = 0; n < nargs; n++) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] === "[") {
        i = skipGroup(text, i, "[", "]");
        while (i < text.length && /\s/.test(text[i])) i++;
      }
      if (text[i] === "{") i = skipGroup(text, i);
    }
    pos = i;
    re.lastIndex = i;
  }
  return out + text.slice(pos);
}

export function stripComments(text: string): string {
  return text.replace(/(?<!\\)%.*/g, "");
}

function preambleOf(mainTex: string): string {
  const end = mainTex.indexOf("\\begin{document}");
  return end >= 0 ? mainTex.slice(0, end) : "";
}

/** Files main.tex \input's before \begin{document} (shared preambles), resolved from the book folder. */
export function preambleInputs(mainTex: string, folder: string): string[] {
  return [...stripComments(preambleOf(mainTex)).matchAll(/\\input\{([^}]+)\}/g)]
    .map((m) => join(folder, /\.tex$/.test(m[1]) ? m[1] : `${m[1]}.tex`))
    .filter((f) => existsSync(f));
}

/** The book's own preamble: what main.tex defines before \begin{document},
 *  without the document class, \input'ed files and the title page fields. */
export function bookPreamble(mainTex: string): string {
  let chunk = removeCommand(preambleOf(mainTex), "documentclass", 1);
  for (const name of ["title", "author", "date", "input"]) chunk = removeCommand(chunk, name, 1);
  return chunk.replace(/\\makeatletter[\s\S]*?\\makeatother/g, "").replace(/^%\s*!TEX.*$/m, "");
}

/** Text-mode commands KaTeX lacks, mapped to close equivalents. */
export const KATEX_EXTRA: Record<string, string> = {
  "\\textsc": "\\textrm{#1}", "\\textup": "\\textrm{#1}", "\\emph": "\\textit{#1}",
  "\\break": "{}", // LaTeX line-break hint; nothing to do on the web
};

/** \newcommand definitions as KaTeX macros, for math pandoc leaves unexpanded
 *  (e.g. inside pseudocode listings). */
export function katexMacros(defs: string): Record<string, string> {
  const macros: Record<string, string> = { ...KATEX_EXTRA };
  const re = /\\(?:re)?newcommand\{(\\[A-Za-z]+)\}(?:\[\d\])?(?=\{)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(defs))) {
    const start = m.index + m[0].length;
    macros[m[1]] = defs.slice(start + 1, skipGroup(defs, start) - 1);
  }
  return macros;
}

/** Macro and theorem definitions pandoc needs in front of every chapter. */
export function pandocDefs(own: string, shared: string, webMacros: string): string {
  const sharedDefs = shared.split("\n")
    .filter((l) => /^\\(newcommand|renewcommand|theoremstyle|newtheorem)/.test(l)).join("\n");
  let chunk = stripComments(own);
  const drop: [string, number][] = [["usepackage", 1], ["RequirePackage", 1], ["usetikzlibrary", 1],
    ["lstdefinelanguage", 2], ["lstdefinestyle", 2], ["lstset", 1], ["setlength", 2], ["pgfplotsset", 1],
    ["tikzset", 1], ["input", 1], ["geometry", 1], ["hypersetup", 1]];
  for (const [name, n] of drop) chunk = removeCommand(chunk, name, n);
  return `${sharedDefs}\n${chunk}\n${webMacros}\n`;
}

/** TeX engine named by a first line "% !TEX program = xelatex" (default pdflatex). */
export function engineOf(mainTex: string): string {
  const m = /^%\s*!TEX\s+program\s*=\s*(\w+)/.exec(mainTex);
  return m ? m[1].toLowerCase() : "pdflatex";
}

export function tikzPreamble(shared: string, own: string): string {
  return "\\documentclass[tikz,border=6pt]{standalone}\n" + shared.replace(/\[chapter\]/g, "") + "\n" + own + "\n";
}

export const TIKZ_RE = /\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/g;

/** Compile pictures {key: source} to <dir>/<key>.svg. Returns the keys that failed. */
export async function compileTikz(dir: string, preamble: string, pictures: Map<string, string>, engine: string): Promise<Set<string>> {
  const todo = new Map([...pictures].filter(([k]) => !existsSync(join(dir, `${k}.svg`))));
  if (!todo.size) return new Set();
  mkdirSync(dir, { recursive: true });

  async function compile(batch: Map<string, string>): Promise<boolean> {
    const tmp = mkdtempSync(join(dir, ".tmp-")); // same filesystem, so the rename below is atomic
    try {
      writeFileSync(join(tmp, "pics.tex"), preamble + "\\begin{document}\n" + [...batch.values()].join("\n") + "\n\\end{document}\n");
      const r = await run(engine, ["-interaction=nonstopmode", "-halt-on-error", "pics.tex"], { cwd: tmp });
      if (r.code !== 0) return false;
      let page = 1;
      for (const key of batch.keys()) {
        const svg = join(tmp, `${key}.svg`);
        const c = await run("pdftocairo", ["-svg", "-f", String(page), "-l", String(page), join(tmp, "pics.pdf"), svg]);
        if (c.code !== 0) return false;
        renameSync(svg, join(dir, `${key}.svg`)); // atomic: chapters compile in parallel
        page++;
      }
      return true;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  if (await compile(todo)) return new Set();
  const failed = new Set<string>();
  for (const [key, src] of todo) { // isolate the bad picture(s)
    if (!(await compile(new Map([[key, src]])))) failed.add(key);
  }
  return failed;
}

export function readIfExists(path: string | undefined): string {
  return path && existsSync(path) ? readFileSync(path, "utf8") : "";
}
