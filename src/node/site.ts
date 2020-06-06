// The whole build: PDFs of LaTeX books, every chapter converted, pages
// rendered, search index written.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import * as pagefind from "pagefind";
import { findCollections, type Collection } from "./collections.js";
import type { Config } from "./config.js";
import { ASSETS, Converter } from "./convert.js";
import { buildPdfs } from "./pdfbuild.js";
import { checkOutput, copyAssets, Renderer } from "./render.js";
import { mapLimit } from "./util.js";

export interface BuildOptions {
  /** Compile the LaTeX books' PDFs (default true). */
  pdf?: boolean;
  /** Rebuild every PDF even if unchanged. */
  force?: boolean;
  /** Fail on any warning. */
  strict?: boolean;
  /** Only these collections (code or folder name). */
  only?: string[];
  /** Skip the search index. */
  noSearch?: boolean;
}

const CLIENT = join(ASSETS, "..", "dist", "client");

function pdfjsDir(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("pdfjs-dist/package.json"));
}

function selected(config: Config, only?: string[]): Collection[] {
  const all = findCollections(config);
  if (!only?.length) return all;
  const picked = all.filter((c) => only.some((o) => o === c.code || o === c.slug || c.folder.endsWith(o)));
  if (!picked.length) throw new Error(`no collection matches ${only.join(", ")}`);
  return picked;
}

export async function buildPdfsOnly(config: Config, opts: BuildOptions = {}): Promise<number> {
  const collections = selected(config, opts.only);
  const results = await buildPdfs(config, collections, { force: opts.force }, printPdf);
  return results.filter((r) => r.problems.length).length;
}

function printPdf(r: { collection: Collection; problems: string[]; pages?: number; skipped: boolean }) {
  const name = r.collection.rel;
  if (r.problems.length) {
    console.log(`FAIL ${name}`);
    for (const p of r.problems.slice(0, 20)) console.log(`     ${p}`);
    if (r.problems.length > 20) console.log(`     ... and ${r.problems.length - 20} more`);
  } else console.log(`ok   ${name} (${r.skipped ? "unchanged" : `${r.pages} pages`})`);
}

export async function build(config: Config, opts: BuildOptions = {}): Promise<{ warnings: string[]; failedPdfs: number }> {
  const collections = selected(config, opts.only);
  if (!collections.length) throw new Error(`no collections found under ${config.root}: add a marginalia.toml or folders of documents`);

  let failedPdfs = 0;
  if (opts.pdf !== false && collections.some((c) => c.kind === "latex")) {
    const results = await buildPdfs(config, collections, { force: opts.force }, printPdf);
    failedPdfs = results.filter((r) => r.problems.length).length;
  } else {
    for (const c of collections) {
      const pdf = join(config.cache, "pdfs", `${c.slug}.pdf`);
      if (c.kind === "latex" && existsSync(pdf)) c.pdf = pdf;
    }
  }

  const out = config.out;
  if (existsSync(out)) rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const hasPdfChapters = collections.some((c) => c.chapters.some((ch) => ch.kind === "pdf"));
  copyAssets(ASSETS, CLIENT, hasPdfChapters ? pdfjsDir() : undefined, out);
  writeFileSync(join(out, ".nojekyll"), "");

  const converter = new Converter(config);
  const jobs = collections.flatMap((c) => {
    const book = converter.prepare(c);
    return c.chapters.map((ch) => ({ ch, book, dir: join(out, c.slug) }));
  });
  // Chapters convert in parallel (pandoc and TikZ run as separate processes).
  await mapLimit(jobs, ({ ch, book, dir }) => converter.convert(ch, book, dir));
  const renderer = new Renderer(config, collections);
  for (const c of collections) {
    renderer.collection(c, out);
    console.log(`${c.code}: ${c.chapters.length} ${c.kind === "latex" ? "chapter" : "part"}${c.chapters.length === 1 ? "" : "s"}`);
  }
  renderer.index(out);
  renderer.navIndex(out);
  const warnings = [...converter.warnings, ...checkOutput(out)];

  if (!opts.noSearch) {
    const { index, errors } = await pagefind.createIndex({});
    if (!index) throw new Error(`pagefind: ${errors.join("; ")}`);
    await index.addDirectory({ path: out });
    await index.writeFiles({ outputPath: join(out, "pagefind") });
    await pagefind.close();
  }
  for (const w of warnings) console.error(`warning: ${w}`);
  console.log(`Site written to ${relative(process.cwd(), out) || "."}`);
  return { warnings, failedPdfs };
}
