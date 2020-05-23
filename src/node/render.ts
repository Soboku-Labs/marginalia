// HTML pages: one per collection (every chapter in one scroll) and the home page.
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Chapter, Collection } from "./collections.js";
import type { Config } from "./config.js";
import { KATEX_EXTRA } from "./latex.js";
import { escapeHtml } from "./util.js";

const KATEX_VERSION = "0.16.9";

const ICONS = {
  pen: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  search: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  draw: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21c3-1 5-4 7-7l3 3c-3 2-6 4-7 7"/><path d="m14 7 3 3"/><path d="M10 14 19.5 4.5a2.1 2.1 0 0 1 3 3L13 17"/></svg>',
  focus: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  theme: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z"/></svg>',
};

interface PageOptions {
  title: string;
  body: string;
  root: string;
  sidebar?: string;
  tocHtml?: string;
  current?: Collection;
  pageClass?: string;
  pageTitle?: string;
  kind?: "page" | "course";
  pdf?: boolean;
}

export class Renderer {
  constructor(private config: Config, private collections: Collection[]) {}

  page(o: PageOptions): string {
    const { config } = this;
    const macros = JSON.stringify(o.current ? o.current.macros : KATEX_EXTRA).replace(/<\//g, "<\\/");
    const links: string[] = [];
    let group: string | null = null;
    for (const c of this.collections) {
      if (c.group !== group) {
        group = c.group;
        if (group) links.push(`<div class="dropdown-label">${escapeHtml(group)}</div>`);
      }
      links.push(`<a class="dropdown-item${c === o.current ? " active" : ""}" href="${o.root}${c.slug}/index.html">` +
        `<b>${escapeHtml(c.code)}</b> ${escapeHtml(c.name)}</a>`);
    }
    const sidebar = o.sidebar ? `<nav class="sidebar" id="sidebar"><div class="sidebar-inner">${o.sidebar}</div></nav>` : "";
    const repoLink = config.repo
      ? `<a class="nav-link" href="${escapeHtml(config.repo)}" aria-label="Source">${/github\.com/.test(config.repo) ? "GitHub" : "Source"}</a>` : "";
    const meta = `data-root="${o.root}" data-kind="${o.kind ?? "page"}" data-course="${o.current?.slug ?? ""}" ` +
      `data-course-code="${escapeHtml(o.current?.code ?? "")}" data-page-title="${escapeHtml(o.pageTitle ?? o.title)}" ` +
      `data-store="${escapeHtml(config.storage)}" data-label="${escapeHtml(config.label)}"`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(o.title)}</title>
${config.description ? `<meta name="description" content="${escapeHtml(config.description)}">\n` : ""}<script>try{var t=localStorage.getItem("theme");if(t)document.documentElement.dataset.theme=t;}catch(e){}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&family=Kalam:wght@400;700&display=swap">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/katex.min.css">
<link rel="stylesheet" href="${o.root}pagefind/pagefind-ui.css">
<link rel="stylesheet" href="${o.root}assets/style.css">
${o.pdf ? `<link rel="stylesheet" href="${o.root}assets/pdfjs/pdf_viewer.css">\n` : ""}
<script type="speculationrules">{"prefetch":[{"where":{"href_matches":"*.html"},"eagerness":"moderate"}]}</script>
</head>
<body class="${o.pageClass ?? ""}" ${meta}>
<header class="navbar">
  <button class="nav-toggle" id="nav-toggle" aria-label="Toggle chapters">&#9776;</button>
  <a class="brand" href="${o.root}index.html"><span class="brand-mark">${escapeHtml(config.brand)}</span> ${escapeHtml(config.title)}</a>
  <div class="dropdown">
    <button class="dropdown-btn">${escapeHtml(o.current?.code ?? config.label)} &#9662;</button>
    <div class="dropdown-menu">${links.join("\n")}</div>
  </div>
  <div class="nav-spacer"></div>
  <button class="jump-btn" id="jump-open" aria-label="Jump to (Ctrl+K)">${ICONS.search}<span class="jump-label">Jump to&hellip;</span><kbd class="jump-kbd">Ctrl K</kbd></button>
  <div id="search" class="search"></div>
  <button class="notes-btn" id="notes-toggle" aria-label="Notes (n)" title="Notes (n)">${ICONS.pen}<span class="notes-btn-label">Notes</span><span class="notes-count" id="notes-count" hidden></span></button>
  <button class="icon-nav" id="draw-toggle" aria-label="Draw / handwriting (d)" title="Draw with Apple Pencil, mouse or finger (d)">${ICONS.draw}</button>
  <button class="icon-nav" id="focus-toggle" aria-label="Focus mode (f)" title="Focus mode (f)">${ICONS.focus}</button>
  ${repoLink}
  <button class="theme-toggle" id="theme-toggle" aria-label="Toggle dark mode">${ICONS.theme}</button>
  <div class="progress" id="progress"></div>
</header>
<div class="layout">
${sidebar}
<main class="content" data-pagefind-body>
${o.body}
</main>
${o.tocHtml ?? ""}
</div>
<script defer src="https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/katex.min.js"></script>
<script defer src="${o.root}pagefind/pagefind-ui.js"></script>
<script>window.KATEX_MACROS = ${macros};</script>
<script defer src="${o.root}assets/app.js"></script>
<script defer src="${o.root}assets/notes.js"></script>
<script defer src="${o.root}assets/ink.js"></script>
<script defer src="${o.root}assets/nav.js"></script>
${o.pdf ? `<script defer src="${o.root}assets/pdf.js"></script>\n` : ""}</body>
</html>
`;
  }

  /** One page per collection: every chapter in order, one continuous scroll. */
  collection(c: Collection, out: string): void {
    const dir = join(out, c.slug);
    mkdirSync(dir, { recursive: true });
    const sections: string[] = [];
    const tocs: string[] = [];
    for (const ch of c.chapters) {
      const [label] = chapterLabel(ch);
      sections.push(`<section class="chapter" id="${ch.slug}" data-chapter="${ch.slug}" ` +
        `data-page-id="${c.slug}/${ch.slug}.html" data-title="${escapeHtml(ch.titleText)}">` +
        `<div class="chapter-head"><div class="chapter-kicker">` +
        `<span class="chapter-label">${/^\d+$/.test(label) ? "Chapter " + label : label}</span>` +
        `<a class="chapter-anchor" href="#${ch.slug}" aria-label="Link to this chapter">#</a></div>` +
        `<h1 class="chapter-title">${ch.titleHtml}</h1></div>` +
        `<div class="chapter-body">${ch.body}</div></section>`);
      tocs.push(`<ul class="toc-chapter" data-chapter="${ch.slug}" hidden>${ch.toc}</ul>`);
      // Old per-chapter addresses point into the one page.
      writeFileSync(join(dir, `${ch.slug}.html`), redirect(ch.titleText, ch.slug));
    }
    const actions: string[] = [];
    if (c.pdf) {
      copyFileSync(c.pdf, join(dir, `${c.slug}.pdf`));
      actions.push(`<a class="button" href="${c.slug}.pdf">Download PDF</a>`);
    }
    if (this.config.repo) {
      const url = `${this.config.repo}/tree/${this.config.branch}/${c.rel.split("/").map(encodeURIComponent).join("/")}`;
      actions.push(`<a class="button secondary" href="${escapeHtml(url)}">${c.kind === "latex" ? "LaTeX source" : "Source"}</a>`);
    }
    const contents = c.chapters.map((ch) => {
      const [label, short] = chapterLabel(ch);
      return `<li><a href="#${ch.slug}"><span class="num">${label}</span><span>${short}</span></a></li>`;
    }).join("\n");
    const crumbs = `<a href="../index.html">${escapeHtml(this.config.label)}</a>${c.group ? " / " + escapeHtml(c.group) : ""}`;
    const n = c.chapters.length;
    const body = `<header class="course-head" id="top">
<div class="breadcrumbs">${crumbs}</div>
<h1 class="course-title">${escapeHtml(c.code)}${c.name ? ` <span class="muted">&mdash; ${escapeHtml(c.name)}</span>` : ""}</h1>
<p class="lead">${n} ${c.kind === "latex" ? "chapter" : "part"}${n === 1 ? "" : "s"} in one scroll. Use the sidebar to jump, or just keep reading.</p>
<div class="actions">${actions.join("")}</div>
<div id="continue-reading"></div>
<details class="contents"><summary>Contents</summary><ol class="chapter-list">${contents}</ol></details>
</header>
${sections.join("")}`;
    const tocHtml = '<aside class="toc"><div class="toc-inner"><div class="toc-title">In this chapter</div>' + tocs.join("") + "</div></aside>";
    const full = c.name ? `${c.code} — ${c.name}` : c.code;
    writeFileSync(join(dir, "index.html"), this.page({
      title: `${full} | ${this.config.title}`, body, root: "../", sidebar: this.sidebar(c), current: c,
      pageClass: "doc", pageTitle: full, kind: "course", tocHtml, pdf: c.chapters.some((ch) => ch.kind === "pdf"),
    }));
    copyImages(c.folder, dir);
  }

  private sidebar(c: Collection): string {
    const items = [
      `<a class="sidebar-course" href="#top">${escapeHtml(c.code)}<span>${escapeHtml(c.name)}</span></a>`,
      '<div class="sidebar-label">Chapters</div>',
      '<input class="sidebar-filter" type="search" placeholder="Filter&hellip;" aria-label="Filter this list">',
    ];
    for (const ch of c.chapters) {
      const [label, short] = chapterLabel(ch);
      items.push(`<a class="sidebar-link" href="#${ch.slug}" data-chapter="${ch.slug}" data-page-id="${c.slug}/${ch.slug}.html" ` +
        `title="${escapeHtml(ch.titleText)}"><span class="num">${label}</span><span>${short}</span></a>`);
    }
    return items.join("\n");
  }

  index(out: string): void {
    const groups: string[] = [];
    for (const g of [...new Set(this.collections.map((c) => c.group))]) {
      const cards = this.collections.filter((c) => c.group === g).map((c) =>
        `<div class="card" data-course="${c.slug}"><a class="card-link" href="${c.slug}/index.html"><span class="card-code">${escapeHtml(c.code)}</span></a>` +
        `<div class="card-name">${escapeHtml(c.name)}</div><div class="card-meta">${c.chapters.length} ${c.kind === "latex" ? "chapter" : "part"}${c.chapters.length === 1 ? "" : "s"}</div></div>`,
      ).join("\n");
      groups.push(`${g ? `<h2 class="subject">${escapeHtml(g)}</h2>\n` : ""}<div class="cards">${cards}</div>`);
    }
    const body = `<section class="hero">
<h1>${escapeHtml(this.config.title)}</h1>
${this.config.description ? `<p class="lead">${escapeHtml(this.config.description)}</p>` : ""}
</section>
<div id="recent-pages"></div>
${groups.join("")}`;
    writeFileSync(join(out, "index.html"), this.page({ title: this.config.title, body, root: "", pageClass: "home" }));
  }

  /** Every collection and chapter, for the Ctrl+K quick jump. */
  navIndex(out: string): void {
    const entries: Record<string, string>[] = [];
    for (const c of this.collections) {
      entries.push({ t: c.name ? `${c.code} — ${c.name}` : c.code, h: `${c.slug}/index.html`, c: c.code, k: "course" });
      for (const ch of c.chapters) {
        const [label] = chapterLabel(ch);
        entries.push({ t: ch.titleText, h: `${c.slug}/index.html#${ch.slug}`, c: c.code, k: "chapter",
          l: /^\d+$/.test(label) ? `Ch ${label}` : label });
      }
    }
    writeFileSync(join(out, "assets", "nav.json"), JSON.stringify(entries));
  }
}

const LECTURE_TITLE_RE = /^(Lecture|Tutorial)\s+0*(\d+)\s*[:.–—-]\s*([\s\S]+)$/;

/** [short label, title without a "Lecture N:" prefix] for sidebars and lists. */
export function chapterLabel(ch: Chapter): [string, string] {
  const m = LECTURE_TITLE_RE.exec(ch.titleHtml);
  if (m) return [`${m[1][0]}${m[2]}`, m[3].trim()];
  return [String(ch.number), ch.titleHtml];
}

function redirect(title: string, slug: string): string {
  const t = escapeHtml(title);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${t}</title>
<meta http-equiv="refresh" content="0; url=index.html#${slug}">
<link rel="canonical" href="index.html#${slug}">
<script>location.replace("index.html#${slug}" + location.search);</script></head>
<body><a href="index.html#${slug}">${t}</a></body></html>
`;
}

const IMAGE = /\.(png|jpe?g|gif|svg|webp|avif)$/i;
const SKIP = new Set(["node_modules", ".git", "_site", "build"]);

/** Images next to the documents, at the same relative paths the pages use. */
function copyImages(folder: string, dest: string): void {
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".") || SKIP.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (IMAGE.test(name)) {
        const target = join(dest, relative(folder, p));
        mkdirSync(join(target, ".."), { recursive: true });
        copyFileSync(p, target);
      }
    }
  };
  if (existsSync(folder)) walk(folder);
}

/** Sanity checks on the generated pages: images exist, no raw LaTeX left. */
export function checkOutput(out: string): string[] {
  const problems: string[] = [];
  const pages: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (!["assets", "pagefind"].includes(name)) walk(p); }
      else if (name.endsWith(".html") && dir !== out) pages.push(p);
    }
  };
  walk(out);
  for (const f of pages.sort()) {
    const text = readFileSync(f, "utf8");
    const main = text.slice(text.indexOf("<main"), text.indexOf("</main>"));
    const rel = relative(out, f);
    for (const [, src] of main.matchAll(/<img src="([^"]+)"/g)) {
      if (!/^(https?:|data:)/.test(src) && !existsSync(join(f, "..", decodeURIComponent(src)))) {
        problems.push(`${rel}: missing image ${src}`);
      }
    }
    const prose = main
      .replace(/<span class="math[^"]*">[\s\S]*?<\/span>/g, "")
      .replace(/<(pre|code)[^>]*>[\s\S]*?<\/\1>/g, "")
      .replace(/<div class="code-block[\s\S]*?<\/div>/g, "")
      .replace(/<div class="pdf-text">[\s\S]*?<\/div>/g, "")
      .replace(/<[^>]*>/g, " "); // visible text only, not attributes
    const leftovers = [...new Set(prose.match(/\\[A-Za-z]+/g) ?? [])].sort();
    if (leftovers.length) problems.push(`${rel}: unconverted LaTeX ${leftovers.slice(0, 8).join(" ")}`);
  }
  return problems;
}

/** Page scripts, styles and the PDF viewer library into <out>/assets. */
export function copyAssets(assetsDir: string, clientDir: string, pdfjsDir: string | undefined, out: string): void {
  const dest = join(out, "assets");
  mkdirSync(dest, { recursive: true });
  copyFileSync(join(assetsDir, "style.css"), join(dest, "style.css"));
  if (!existsSync(clientDir)) throw new Error(`${clientDir} is missing: run npm run build in notes-site`);
  for (const f of readdirSync(clientDir)) copyFileSync(join(clientDir, f), join(dest, f));
  if (pdfjsDir) {
    mkdirSync(join(dest, "pdfjs"), { recursive: true });
    for (const f of ["pdf.min.mjs", "pdf.worker.min.mjs"]) copyFileSync(join(pdfjsDir, "build", f), join(dest, "pdfjs", f));
    cpSync(join(pdfjsDir, "web", "pdf_viewer.css"), join(dest, "pdfjs", "pdf_viewer.css"));
  }
}
