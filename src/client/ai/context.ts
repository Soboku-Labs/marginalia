// The notes as plain text for the model: each chapter of the open page, with
// formulas turned back into their TeX and the reader's own typed notes kept.
import type { ChapterRef } from "./markdown";

export interface Chapter extends ChapterRef { section: HTMLElement }

export function chaptersOnPage(): Chapter[] {
  return Array.from(document.querySelectorAll<HTMLElement>("section.chapter")).map((section) => ({
    section, slug: section.id, title: section.dataset.title || section.id,
  }));
}

const BLOCKS = "p, li, h1, h2, h3, h4, h5, pre, tr, blockquote, .thm, .callout, figure, .pdf-page, .user-note, .code-block";

/** Readable text of a chapter: math as $TeX$, line breaks between blocks. */
export function chapterText(ch: Chapter): string {
  const clone = ch.section.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".ink-layer, .add-note-btn, .chapter-anchor, .copy-btn, .pdf-canvas, .textLayer, button, script")
    .forEach((n) => n.remove());
  clone.querySelectorAll<HTMLElement>(".katex").forEach((k) => {
    const tex = k.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    const display = !!k.closest(".katex-display");
    const target = k.closest(".katex-display") || k;
    target.replaceWith(document.createTextNode(tex ? (display ? `\n$$${tex}$$\n` : `$${tex}$`) : ""));
  });
  clone.querySelectorAll(BLOCKS).forEach((b) => b.append("\n"));
  return (clone.textContent || "").replace(/[ \t ]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}

export interface Context { text: string; refs: ChapterRef[]; truncated: boolean }

/** The given chapters, each under a "[[slug]] Title" header, within maxChars. */
export function contextFor(chapters: Chapter[], maxChars: number): Context {
  const texts = chapters.map((c) => chapterText(c));
  const total = texts.reduce((n, t) => n + t.length, 0);
  // Over budget: every chapter keeps the same share of its text (stated in the UI).
  const ratio = total > maxChars ? maxChars / total : 1;
  const parts = chapters.map((c, i) => {
    const t = ratio < 1 ? texts[i].slice(0, Math.floor(texts[i].length * ratio)) : texts[i];
    return `### [[${c.slug}]] ${c.title}\n\n${t}`;
  });
  return { text: parts.join("\n\n"), refs: chapters, truncated: ratio < 1 };
}

const STOP = new Set("the a an and or of to in is are was for on with as by that this it be at from which what how why when".split(" "));

function words(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w));
}

/** For a question: the chapter being read, then the chapters that share the most words with it. */
export function contextForQuestion(question: string, current: Chapter | null, all: Chapter[], maxChars: number): Context {
  const q = new Set(words(question));
  const scored = all.filter((c) => c !== current).map((c) => {
    const ws = words(chapterText(c));
    let hits = 0;
    for (const w of ws) if (q.has(w)) hits++;
    return { c, score: hits / Math.sqrt(ws.length + 1) };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  const picked: Chapter[] = current ? [current] : [];
  let size = current ? chapterText(current).length : 0;
  for (const { c } of scored) {
    const n = chapterText(c).length;
    if (size + n > maxChars) continue;
    picked.push(c);
    size += n;
    if (picked.length >= 6) break;
  }
  return contextFor(picked.length ? picked : all.slice(0, 1), maxChars);
}
