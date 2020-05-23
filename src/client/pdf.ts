// PDF chapters: each page is a block of the chapter (so handwriting and typed
// notes anchor to it). Pages render with pdf.js as they come near the screen,
// with a text layer for selecting and copying; the page text the build
// extracted stays in the page for search.
import { debounce, rootUrl } from "./util";

interface Viewport { width: number; height: number; scale: number }
interface PdfPage {
  getViewport(o: { scale: number }): Viewport;
  render(o: { canvasContext: CanvasRenderingContext2D; viewport: Viewport; transform?: number[] }): { promise: Promise<void> };
  streamTextContent(): unknown;
}
interface PdfDoc { getPage(n: number): Promise<PdfPage> }
interface PdfJs {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(src: string): { promise: Promise<PdfDoc> };
  TextLayer: new (o: { textContentSource: unknown; container: HTMLElement; viewport: Viewport }) => { render(): Promise<void> };
}

const pages = Array.from(document.querySelectorAll<HTMLElement>(".pdf-page[data-src]"));
let lib: Promise<PdfJs> | null = null;
const docs = new Map<string, Promise<PdfDoc>>();

function pdfjs(): Promise<PdfJs> {
  lib ??= (import(/* webpackIgnore: true */ new URL("assets/pdfjs/pdf.min.mjs", rootUrl).href) as Promise<PdfJs>).then((m) => {
    m.GlobalWorkerOptions.workerSrc = new URL("assets/pdfjs/pdf.worker.min.mjs", rootUrl).href;
    return m;
  });
  return lib;
}

function docFor(src: string): Promise<PdfDoc> {
  const url = new URL(src, location.href).href;
  let d = docs.get(url);
  if (!d) {
    d = pdfjs().then((m) => m.getDocument(url).promise);
    docs.set(url, d);
  }
  return d;
}

/** Width each page was last drawn at, so a resize redraws only when it matters. */
const drawnWidth = new WeakMap<HTMLElement, number>();

async function draw(el: HTMLElement): Promise<void> {
  const width = el.clientWidth;
  if (!width || Math.abs((drawnWidth.get(el) ?? 0) - width) < 2) return;
  drawnWidth.set(el, width);
  try {
    const [m, doc] = await Promise.all([pdfjs(), docFor(el.dataset.src!)]);
    const page = await doc.getPage(Number(el.dataset.page));
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const ratio = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    canvas.className = "pdf-canvas";
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    await page.render({ canvasContext: ctx, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined }).promise;
    const text = document.createElement("div");
    text.className = "textLayer";
    text.style.setProperty("--scale-factor", String(viewport.scale));
    el.querySelectorAll(".pdf-canvas, .textLayer").forEach((old) => old.remove());
    el.append(canvas, text);
    el.classList.add("rendered");
    await new m.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport }).render();
  } catch (e) {
    drawnWidth.delete(el);
    el.classList.add("failed");
    console.warn("PDF page failed to render", e);
  }
}

if (pages.length) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) void draw(e.target as HTMLElement);
  }, { rootMargin: "1200px 0px" });
  pages.forEach((p) => io.observe(p));
  // Redraw visible pages at the new width (the canvas scales meanwhile).
  window.addEventListener("resize", debounce(() => {
    const h = window.innerHeight;
    for (const p of pages) {
      const r = p.getBoundingClientRect();
      if (r.bottom > -h && r.top < 2 * h) void draw(p);
      else drawnWidth.delete(p);
    }
  }, 250));
}
