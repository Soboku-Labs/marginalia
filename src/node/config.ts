// marginalia.toml: what the site is called and where its documents are.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";

export interface GroupConfig {
  /** Heading on the home page and in the menu (e.g. "Computer Science"). */
  name: string;
  /** Folder whose subfolders are the group's collections. */
  path: string;
}

export interface CollectionConfig {
  /** Folder of the collection (a LaTeX book, Markdown files and/or PDFs). */
  path: string;
  /** Group it is listed under (default: none). */
  group?: string;
  code?: string;
  title?: string;
}

export interface Config {
  root: string;
  title: string;
  description: string;
  /** Mark shown before the title in the navbar. */
  brand: string;
  /** What a collection is called in the menu, e.g. "Courses". */
  label: string;
  /** Repository URL: a GitHub link in the navbar and a source button per collection. */
  repo: string;
  branch: string;
  /** Prefix of the browser storage keys (notes, highlights, ink). */
  storage: string;
  out: string;
  cache: string;
  groups: GroupConfig[];
  collections: CollectionConfig[];
  latex: {
    /** Shared preamble every book \input's (its \newcommand's are used on the website). */
    preamble?: string;
    /** Extra LaTeX definitions used only on the website (e.g. web versions of macros). */
    webMacros?: string;
  };
  deploy: { cloudflareProject?: string };
}

const FILE = "marginalia.toml";

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function opt(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function table(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function tables(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(table) : [];
}

export function loadConfig(rootArg = "."): Config {
  const root = resolve(rootArg);
  const file = join(root, FILE);
  const raw = existsSync(file) ? table(parse(readFileSync(file, "utf8"))) : {};
  const latex = table(raw.latex);
  const deploy = table(raw.deploy);
  return {
    root,
    title: str(raw.title, "Notes"),
    description: str(raw.description, ""),
    brand: str(raw.brand, "∑"),
    label: str(raw.label, "Notes"),
    repo: str(raw.repo, "").replace(/\/+$/, ""),
    branch: str(raw.branch, "main"),
    storage: str(raw.storage, "marginalia"),
    out: resolve(root, str(raw.out, "_site")),
    cache: resolve(root, str(raw.cache, ".marginalia")),
    groups: tables(raw.group).map((g) => ({ name: str(g.name, str(g.path, "")), path: str(g.path, "") }))
      .filter((g) => g.path),
    collections: tables(raw.collection).map((c) => ({
      path: str(c.path, ""), group: opt(c.group), code: opt(c.code), title: opt(c.title),
    })).filter((c) => c.path),
    latex: { preamble: opt(latex.preamble), webMacros: opt(latex.web_macros) },
    deploy: { cloudflareProject: opt(deploy.cloudflare_project) },
  };
}
