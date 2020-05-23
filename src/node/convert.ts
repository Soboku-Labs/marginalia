// Chapter conversion: LaTeX and Markdown through pandoc (filter.lua, KaTeX
// math, TikZ as SVG), PDFs as pages for the in-browser viewer plus their text
// for search.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Chapter, Collection } from "./collections.js";
import type { Config } from "./config.js";
import {
  bookPreamble, compileTikz, engineOf, katexMacros, pandocDefs, preambleInputs, readIfExists, skipGroup, TIKZ_RE, tikzPreamble,
} from "./latex.js";
import { escapeHtml, run, sha1, stripTags } from "./util.js";

export const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets");
const FILTER = join(ASSETS, "filter.lua");
const TEMPLATE = join(ASSETS, "fragment.html");
const TIKZ_ZOOM = 1.4;

const TITLE_RE = /\\begin\{important\}\[((?:[^[\]]|\[[^\]]*\])*)\]/g;
const HEADING_RE = /<h([23])[^>]*?\sid="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g;
const H1_RE = /<h1[^>]*>([\s\S]*?)<\/h1>/;

/** Per-collection LaTeX context shared by its chapters. */
interface BookContext { defs: string; tikzPre: string; engine: string }

export class Converter {
  warnings: string[] = [];
  private katexOption?: Promise<string>;
  private filterHash = sha1(readFileSync(FILTER), readFileSync(TEMPLATE));

  constructor(private config: Config) {}

  /** Set up a collection before its chapters convert (LaTeX macros, TikZ preamble). */
  prepare(c: Collection): BookContext | undefined {
    if (c.kind !== "latex" || !c.mainTex) return undefined;
    // The shared preamble: the configured one, else whatever main.tex \input's.
    const sharedFiles = this.config.latex.preamble
      ? [join(this.config.root, this.config.latex.preamble)] : preambleInputs(c.mainTex, c.folder);
    const shared = sharedFiles.map((f) => readIfExists(f)).join("\n");
    const own = bookPreamble(c.mainTex);
    const web = readIfExists(this.config.latex.webMacros ? join(this.config.root, this.config.latex.webMacros) : undefined);
    const defs = pandocDefs(own, shared, web);
    c.macros = katexMacros(defs);
    return { defs, tikzPre: tikzPreamble(shared, own), engine: engineOf(c.mainTex) };
  }

  async convert(ch: Chapter, book: BookContext | undefined, outDir: string): Promise<void> {
    if (!existsSync(ch.path)) {
      this.warn(ch, `missing file ${ch.path}`);
      ch.titleHtml = escapeHtml(ch.slug);
      ch.titleText = ch.slug;
      return;
    }
    if (ch.kind === "pdf") return this.convertPdf(ch, outDir);
    let source = readFileSync(ch.path, "utf8");
    let defs = "";
    if (ch.kind === "latex" && book) {
      source = await this.latexSource(ch, source, book, outDir);
      defs = book.defs;
    } else {
      source = markdownTitle(source, ch);
    }
    const args = ["-f", ch.kind === "latex" ? "latex" : "markdown", "-t", "html5", await this.katex(),
      "--template", TEMPLATE, "--lua-filter", FILTER,
      "--number-sections", `--number-offset=${ch.number - 1}`, `--id-prefix=${ch.slug}-`,
      "-M", `chapnum=${ch.number}`, "-M", "imgprefix=", "-M", "pagetitle=chapter", "--wrap=none"];
    const { stdout, stderr } = await this.pandoc(args, defs, source, ch);
    for (const line of stderr.split("\n")) if (line.includes("WARNING")) this.warn(ch, line.trim());
    let body = stdout.split("<!--@@SPLIT@@-->").slice(-1)[0];
    body = body.replace(/<img src="tikz\/([0-9a-f]+)\.svg"/g, (m, key: string) => {
      // pdftocairo writes the size in pt; show figures a bit larger than print.
      const svg = join(this.tikzDir, `${key}.svg`);
      const w = existsSync(svg) ? /width="([\d.]+)(?:pt)?"/.exec(readFileSync(svg, "utf8").slice(0, 500)) : null;
      return m + (w ? ` width="${Math.round(parseFloat(w[1]) * 1.333 * TIKZ_ZOOM)}"` : "");
    });
    const h1 = H1_RE.exec(body);
    if (h1) {
      ch.titleHtml = h1[1].replace(/<span class="header-section-number">[\s\S]*?<\/span>\s*/, "").trim();
      body = body.slice(0, h1.index) + body.slice(h1.index + h1[0].length);
    } else {
      ch.titleHtml = escapeHtml(prettyName(ch.path));
    }
    ch.titleText = stripTags(ch.titleHtml);
    ch.body = body.trim();
    ch.toc = [...body.matchAll(HEADING_RE)].map(([, level, id, inner]) =>
      `<li class="toc-l${level}"><a href="#${id}">${inner.replace(/<span class="header-section-number">([\s\S]*?)<\/span>/g, '<span class="toc-num">$1</span>')}</a></li>`,
    ).join("\n");
  }

  private get tikzDir(): string {
    return join(this.config.cache, "tikz");
  }

  private warn(ch: Chapter, msg: string) {
    this.warnings.push(`${ch.collection.code} ${ch.slug}: ${msg}`);
  }

  /** --math-method=katex on newer pandoc (which deprecates --katex), else --katex. */
  private katex(): Promise<string> {
    this.katexOption ??= run("pandoc", ["-f", "latex", "-t", "html5", "--math-method=katex"], { input: "$x$" })
      .then((r) => (r.code === 0 ? "--math-method=katex" : "--katex"));
    return this.katexOption;
  }

  /** pandoc's output, cached by everything that affects it. */
  private async pandoc(args: string[], defs: string, source: string, ch: Chapter): Promise<{ stdout: string; stderr: string }> {
    const dir = join(this.config.cache, "pandoc");
    const cached = join(dir, `${sha1(args.join("\0"), defs, source, this.filterHash)}.json`);
    if (existsSync(cached)) return JSON.parse(readFileSync(cached, "utf8"));
    const r = await run("pandoc", args, { input: defs + source });
    if (r.code !== 0) {
      const offset = defs.split("\n").length - 1;
      const err = r.stderr.replace(/line (\d+)/g, (_, n: string) => `line ${Number(n) - offset}`);
      throw new Error(`pandoc failed on ${ch.path}:\n${err}`);
    }
    mkdirSync(dir, { recursive: true });
    const tmp = `${cached}.${process.pid}.${ch.slug}.tmp`;
    writeFileSync(tmp, JSON.stringify({ stdout: r.stdout, stderr: r.stderr }));
    renameSync(tmp, cached);
    return { stdout: r.stdout, stderr: r.stderr };
  }

  /** Chapter LaTeX with titled boxes marked for filter.lua and TikZ pictures compiled to SVG. */
  private async latexSource(ch: Chapter, tex: string, book: BookContext, outDir: string): Promise<string> {
    tex = tex.replace(TITLE_RE, (_, title: string) => "\\begin{important}\n\n\\textbf{@@T@@" + title + "}\n\n");
    // Styles a chapter defines with \tikzset are needed by its pictures.
    const styles: string[] = [];
    for (const m of tex.matchAll(/\\tikzset\s*(?=\{)/g)) {
      const start = m.index ?? 0;
      styles.push(tex.slice(start, skipGroup(tex, start + m[0].length)));
    }
    const pre = book.tikzPre + styles.join("\n") + "\n";
    const pictures = new Map<string, string>();
    tex = tex.replace(TIKZ_RE, (src) => {
      const key = sha1(pre, src).slice(0, 16);
      pictures.set(key, src);
      return "\\includegraphics{@@TIKZ@@" + key + "}";
    });
    if (pictures.size) {
      const failed = await compileTikz(this.tikzDir, pre, pictures, book.engine);
      for (const key of failed) this.warn(ch, `TikZ picture ${key} failed to compile`);
      mkdirSync(join(outDir, "tikz"), { recursive: true });
      for (const key of pictures.keys()) {
        if (!failed.has(key)) copyFileSync(join(this.tikzDir, `${key}.svg`), join(outDir, "tikz", `${key}.svg`));
      }
    }
    return tex;
  }

  /** A PDF chapter: one block per page (rendered by the viewer), with the page text for search. */
  private async convertPdf(ch: Chapter, outDir: string): Promise<void> {
    const data = readFileSync(ch.path);
    const info = await this.pdfInfo(ch, data);
    const file = `files/${ch.slug}.pdf`;
    mkdirSync(join(outDir, "files"), { recursive: true });
    copyFileSync(ch.path, join(outDir, file));
    ch.titleHtml = escapeHtml(info.title || prettyName(ch.path));
    ch.titleText = stripTags(ch.titleHtml);
    const pages = info.pages.map((p, i) =>
      `<div class="pdf-page hl-ignore" data-src="${file}" data-page="${i + 1}" style="aspect-ratio: ${p.w} / ${p.h}">` +
      `<div class="pdf-text">${escapeHtml(p.text)}</div></div>`);
    ch.body = `<p class="pdf-actions hl-ignore"><a class="button secondary" href="${file}">Open PDF</a>` +
      `<span class="muted">${info.pages.length} page${info.pages.length === 1 ? "" : "s"}</span></p>\n` + pages.join("\n");
    ch.toc = "";
  }

  private async pdfInfo(ch: Chapter, data: Buffer): Promise<PdfInfo> {
    const dir = join(this.config.cache, "pdf");
    const cached = join(dir, `${sha1(data)}.json`);
    if (existsSync(cached)) return JSON.parse(readFileSync(cached, "utf8"));
    const meta = await run("pdfinfo", [ch.path]);
    if (meta.code !== 0) throw new Error(`pdfinfo failed on ${ch.path}:\n${meta.stderr}`);
    const count = Number(/^Pages:\s+(\d+)/m.exec(meta.stdout)?.[1] ?? 0);
    const title = /^Title:\s+(.+)$/m.exec(meta.stdout)?.[1].trim() ?? "";
    const sizes = await run("pdfinfo", ["-f", "1", "-l", String(count), ch.path]);
    const dims: { w: number; h: number }[] = [];
    for (const m of sizes.stdout.matchAll(/^Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+)/gm)) {
      dims[Number(m[1]) - 1] = { w: Math.round(Number(m[2])), h: Math.round(Number(m[3])) };
    }
    for (const m of sizes.stdout.matchAll(/^Page\s+(\d+) rot:\s+(\d+)/gm)) {
      const d = dims[Number(m[1]) - 1];
      if (d && Number(m[2]) % 180 === 90) dims[Number(m[1]) - 1] = { w: d.h, h: d.w };
    }
    const text = await run("pdftotext", ["-enc", "UTF-8", ch.path, "-"]);
    const texts = text.stdout.split("\f");
    const info: PdfInfo = {
      // Ignore generic titles that tools write ("untitled", "Microsoft Word - x.docx").
      title: /^(untitled|microsoft|document\d*$)/i.test(title) ? "" : title,
      pages: Array.from({ length: count }, (_, i) => ({
        w: dims[i]?.w ?? 612, h: dims[i]?.h ?? 792, text: (texts[i] ?? "").replace(/\s+/g, " ").trim(),
      })),
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(cached, JSON.stringify(info));
    return info;
  }
}

interface PdfInfo { title: string; pages: { w: number; h: number; text: string }[] }

/** "03-graph_theory.md" -> "Graph theory". */
export function prettyName(path: string): string {
  const name = basename(path, extname(path)).replace(/^\d+[\s._-]*/, "").replace(/[_-]+/g, " ").trim();
  return name ? name[0].toUpperCase() + name.slice(1) : basename(path);
}

/** A Markdown chapter's title: its first "# heading", else front matter "title:", else the file name. */
function markdownTitle(source: string, ch: Chapter): string {
  const front = /^---\n([\s\S]*?)\n(?:---|\.\.\.)\n/.exec(source);
  const body = front ? source.slice(front[0].length) : source;
  if (/^#\s+\S/m.test(body.replace(/```[\s\S]*?```/g, ""))) return source;
  const t = front ? /^title:\s*["']?(.+?)["']?\s*$/m.exec(front[1])?.[1] : undefined;
  return (front ? front[0] : "") + `# ${t || prettyName(ch.path)}\n\n` + body;
}
