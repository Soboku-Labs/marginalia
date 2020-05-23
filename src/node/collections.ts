// Collections: a LaTeX book (main.tex + \include'd chapters) or a folder of
// Markdown files and/or PDFs (one chapter each). Every collection is one page.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import type { CollectionConfig, Config } from "./config.js";
import { naturalCompare, slugify } from "./util.js";

export type ChapterKind = "latex" | "markdown" | "pdf";

export interface Chapter {
  collection: Collection;
  number: number;
  kind: ChapterKind;
  path: string;
  slug: string;
  titleHtml: string;
  titleText: string;
  body: string;
  toc: string;
}

export interface Collection {
  folder: string;
  /** Path relative to the project root (for source links). */
  rel: string;
  group: string;
  code: string;
  name: string;
  slug: string;
  kind: "latex" | "files";
  chapters: Chapter[];
  mainTex?: string;
  /** The book's PDF (LaTeX books, once built). */
  pdf?: string;
  macros: Record<string, string>;
}

const README = /^(readme|index)\.md$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", "_site", "dist"]);

function files(folder: string): string[] {
  try {
    return readdirSync(folder).filter((f) => statSync(join(folder, f)).isFile());
  } catch {
    return [];
  }
}

export function isCollection(folder: string): boolean {
  if (existsSync(join(folder, "main.tex"))) return true;
  return files(folder).some((f) => (/\.md$/i.test(f) && !README.test(f)) || /\.pdf$/i.test(f));
}

function subfolders(folder: string): string[] {
  try {
    return readdirSync(folder)
      .filter((f) => !f.startsWith(".") && !SKIP_DIRS.has(f) && statSync(join(folder, f)).isDirectory())
      .sort(naturalCompare).map((f) => join(folder, f));
  } catch {
    return [];
  }
}

/** First "# Heading" of a README, as a fallback collection title. */
function readmeTitle(folder: string): string {
  const readme = files(folder).find((f) => README.test(f));
  if (!readme) return "";
  const m = /^#\s+(.+)$/m.exec(readFileSync(join(folder, readme), "utf8"));
  return m ? m[1].trim() : "";
}

function makeCollection(config: Config, folder: string, group: string, override: Partial<CollectionConfig> = {}): Collection {
  const c: Collection = {
    folder, rel: relative(config.root, folder), group,
    code: basename(folder), name: "", slug: slugify(basename(folder)),
    kind: "files", chapters: [], macros: {},
  };
  const main = join(folder, "main.tex");
  if (existsSync(main)) {
    c.kind = "latex";
    c.mainTex = readFileSync(main, "utf8");
    // \title{CODE --- Name} gives the code and name; otherwise the title is the name.
    const t = /\\title\{(.*?)\}/.exec(c.mainTex);
    if (t) {
      const [code, ...rest] = t[1].split("---");
      if (rest.length) { c.code = code.trim() || c.code; c.name = rest.join("---").trim(); }
      else c.name = t[1].trim();
    }
    const includes = [...c.mainTex.matchAll(/^\s*\\include\{([^}]+)\}/gm)].map((m) => m[1]);
    c.chapters = includes.map((inc, i) => chapter(c, i + 1, "latex", join(folder, `${inc}.tex`), basename(inc)));
  } else {
    c.name = readmeTitle(folder);
    const docs = files(folder)
      .filter((f) => (/\.md$/i.test(f) && !README.test(f)) || /\.pdf$/i.test(f))
      .sort(naturalCompare);
    const used = new Set<string>();
    c.chapters = docs.map((f, i) => {
      let slug = slugify(basename(f, extname(f))) || `part-${i + 1}`;
      while (used.has(slug)) slug += "-x";
      used.add(slug);
      return chapter(c, i + 1, /\.pdf$/i.test(f) ? "pdf" : "markdown", join(folder, f), slug);
    });
  }
  if (override.code) c.code = override.code;
  if (override.title) c.name = override.title;
  return c;
}

function chapter(collection: Collection, number: number, kind: ChapterKind, path: string, slug: string): Chapter {
  return { collection, number, kind, path, slug, titleHtml: "", titleText: "", body: "", toc: "" };
}

/** Every collection, in display order (groups as configured, then the rest). */
export function findCollections(config: Config): Collection[] {
  const out: Collection[] = [];
  const seen = new Set<string>();
  const add = (folder: string, group: string, override?: Partial<CollectionConfig>) => {
    if (seen.has(folder) || !isCollection(folder)) return;
    seen.add(folder);
    out.push(makeCollection(config, folder, group, override));
  };
  for (const g of config.groups) {
    const dir = join(config.root, g.path);
    if (isCollection(dir)) add(dir, g.name);
    else for (const sub of subfolders(dir)) add(sub, g.name);
  }
  for (const c of config.collections) add(join(config.root, c.path), c.group ?? "", c);
  if (!config.groups.length && !config.collections.length) {
    // No configuration: top-level collections, and folders of collections as groups.
    const skip = new Set([config.out, config.cache]);
    for (const dir of subfolders(config.root).filter((d) => !skip.has(d))) {
      if (isCollection(dir)) add(dir, "");
      else for (const sub of subfolders(dir)) add(sub, basename(dir));
    }
  }
  // Unique page folders.
  const slugs = new Set<string>();
  for (const c of out) {
    while (slugs.has(c.slug)) c.slug += "-2";
    slugs.add(c.slug);
  }
  return out;
}
