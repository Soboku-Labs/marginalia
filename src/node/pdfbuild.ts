// PDFs of the LaTeX books: compiled with latexmk (pdflatex, or the engine named
// by "% !TEX program = ..."), checked for errors, undefined references, missing
// characters and chapters left out of main.tex. A book whose files have not
// changed since its last clean build is skipped.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { Collection } from "./collections.js";
import type { Config } from "./config.js";
import { engineOf, preambleInputs } from "./latex.js";
import { mapLimit, run, sha1 } from "./util.js";

const LOG_PROBLEMS: [RegExp, string][] = [
  [/^! .*/gm, "error"],
  [/LaTeX Warning: Reference `[^']*' on page \d+ undefined.*/gm, "undefined reference"],
  [/LaTeX Warning: Citation `[^']*' on page \d+ undefined.*/gm, "undefined citation"],
  [/Missing character: There is no .*/gm, "missing character"],
];

// Files LaTeX writes next to main.tex (not inputs of the book).
const BUILD_OUTPUT = /\.(aux|log|fls|fdb_latexmk|out|toc|xdv|lof|lot|bbl|blg|synctex\.gz)$|^main\.pdf$/;

export interface PdfResult { collection: Collection; problems: string[]; pages?: number; skipped: boolean }

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (!BUILD_OUTPUT.test(name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function inputsHash(config: Config, c: Collection): string {
  const files = listFiles(c.folder);
  if (config.latex.preamble) files.unshift(join(config.root, config.latex.preamble));
  if (c.mainTex) files.unshift(...preambleInputs(c.mainTex, c.folder).filter((f) => !files.includes(f)));
  return sha1(...files.flatMap((f) => [relative(config.root, f), existsSync(f) ? readFileSync(f) : ""]));
}

/** Chapter files that main.tex never \include's, and includes with no file. */
function checkIncludes(c: Collection): string[] {
  const problems: string[] = [];
  const dirs = new Set(c.chapters.map((ch) => dirname(ch.path)));
  const included = new Set(c.chapters.map((ch) => ch.path));
  for (const d of dirs) {
    if (d === c.folder || !existsSync(d)) continue;
    for (const f of readdirSync(d).filter((f) => f.endsWith(".tex")).sort()) {
      if (!included.has(join(d, f))) problems.push(`${relative(c.folder, join(d, f))} is not included in main.tex`);
    }
  }
  for (const ch of c.chapters) if (!existsSync(ch.path)) problems.push(`main.tex includes missing ${relative(c.folder, ch.path)}`);
  return problems;
}

async function compile(c: Collection, dest: string): Promise<{ problems: string[]; pages?: number }> {
  const out = mkdtempSync(join(tmpdir(), "notes-site-pdf-"));
  try {
    const engine = engineOf(c.mainTex ?? "") === "xelatex" ? "-xelatex" : engineOf(c.mainTex ?? "") === "lualatex" ? "-lualatex" : "-pdf";
    const r = await run("latexmk", [engine, "-interaction=nonstopmode", "-halt-on-error", `-outdir=${out}`, "main.tex"], { cwd: c.folder });
    const logPath = join(out, "main.log");
    const log = existsSync(logPath) ? readFileSync(logPath, "latin1") : r.stdout;
    const problems: string[] = [];
    for (const [re, kind] of LOG_PROBLEMS) for (const m of log.matchAll(re)) problems.push(`${kind}: ${m[0].trim()}`);
    if (r.code !== 0 && !problems.length) problems.push(`latexmk exited with status ${r.code}`);
    let pages: number | undefined;
    if (existsSync(join(out, "main.pdf"))) {
      const m = /Output written on .*?\((\d+) pages?/.exec(log);
      pages = m ? Number(m[1]) : undefined;
      copyFileSync(join(out, "main.pdf"), dest);
    }
    return { problems, pages };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Build (or reuse) every LaTeX book's PDF into <cache>/pdfs/<slug>.pdf. */
export async function buildPdfs(config: Config, collections: Collection[], opts: { force?: boolean; jobs?: number } = {},
  report: (r: PdfResult) => void = () => {}): Promise<PdfResult[]> {
  const dir = join(config.cache, "pdfs");
  mkdirSync(dir, { recursive: true });
  const books = collections.filter((c) => c.kind === "latex");
  return mapLimit(books, async (c) => {
    const pdf = join(dir, `${c.slug}.pdf`);
    const stamp = join(dir, `${c.slug}.inputs`);
    const digest = inputsHash(config, c);
    let result: PdfResult;
    if (!opts.force && existsSync(pdf) && existsSync(stamp) && readFileSync(stamp, "utf8") === digest) {
      result = { collection: c, problems: [], skipped: true };
    } else {
      const problems = checkIncludes(c);
      const built = await compile(c, pdf);
      problems.push(...built.problems);
      // Only a clean build may be skipped next time.
      if (problems.length) { if (existsSync(stamp)) unlinkSync(stamp); }
      else writeFileSync(stamp, digest);
      result = { collection: c, problems, pages: built.pages, skipped: false };
    }
    if (existsSync(pdf)) c.pdf = pdf;
    report(result);
    return result;
  }, opts.jobs);
}
