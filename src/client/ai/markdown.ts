// Markdown from the model, rendered safely: everything is escaped first, then a
// small subset (headings, lists, code, bold/italic, $math$, chapter citations)
// is turned back into HTML. The model can never inject markup of its own.

function escapeHtml(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface ChapterRef { slug: string; title: string }

function inline(text: string, refs: Map<string, ChapterRef>): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    // [[chapter-slug]] citations become links into the page.
    .replace(/\[\[([A-Za-z0-9_-]+)\]\]/g, (_m, slug: string) => {
      const ref = refs.get(slug);
      return ref ? `<a class="ai-cite" href="#${slug}" title="${escapeHtml(ref.title)}">${escapeHtml(ref.title)}</a>` : "";
    });
}

/** Markdown (with $..$ / $$..$$ math) to HTML; math becomes span.math for KaTeX. */
export function renderMarkdown(src: string, refs: ChapterRef[] = []): string {
  const refMap = new Map(refs.map((r) => [r.slug, r]));
  const maths: { tex: string; display: boolean }[] = [];
  const codes: string[] = [];
  let t = src.replace(/```[^\n]*\n([\s\S]*?)(```|$)/g, (_m, code: string) => {
    codes.push(code.replace(/\n$/, ""));
    return `\u0001${codes.length - 1}\u0001`;
  });
  t = t.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^$\n]+?)\$|\\\(([^\n]+?)\\\)/g,
    (_m, d?: string, d2?: string, i?: string, i2?: string) => {
      maths.push({ tex: (d ?? d2 ?? i ?? i2 ?? "").trim(), display: d != null || d2 != null });
      return `\u0000${maths.length - 1}\u0000`;
    });
  const out: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map((l) => inline(l, refMap)).join("<br>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i, refMap)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  for (const line of t.split("\n")) {
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if (/^\u0001\d+\u0001$/.test(line.trim())) { flushPara(); flushList(); out.push(line.trim()); continue; }
    if (heading) {
      flushPara(); flushList();
      const level = Math.min(6, heading[1].length + 2);
      out.push(`<h${level}>${inline(heading[2], refMap)}</h${level}>`);
    } else if (bullet || numbered) {
      flushPara();
      const tag = bullet ? "ul" : "ol";
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push((bullet ?? numbered)![1]);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return out.join("")
    .replace(/\u0001(\d+)\u0001/g, (_m, i: string) => `<pre class="ai-code"><code>${escapeHtml(codes[Number(i)])}</code></pre>`)
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => {
      const m = maths[Number(i)];
      return `<span class="math ${m.display ? "display" : "inline"}">${escapeHtml(m.tex)}</span>`;
    });
}
