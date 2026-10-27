// AI study tools, with the reader's own model ("bring your own model"):
//  - Ask: questions answered from the notes, citing chapters;
//  - Explain: select text, then explain / simplify / example / summarize, and keep the answer as a margin note;
//  - Test: practice tests written to the reader's request, graded with explanations;
//  - Study: flashcards with spaced repetition, and a study plan up to a date.
// Settings, tests, decks and plans live in this browser's storage.
import { chat, parseJson, PROVIDERS, type AiSettings, type ChatMessage, type ProviderId } from "./ai/providers";
import { chaptersOnPage, contextFor, contextForQuestion, type Chapter, type Context } from "./ai/context";
import { renderMarkdown, type ChapterRef } from "./ai/markdown";
import {
  askSystem, cardsSystem, CARDS_SCHEMA, EXPLAIN_LABELS, explainPrompt, gradeSystem, GRADE_SCHEMA, planSystem,
  PLAN_SCHEMA, testSystem, TEST_SCHEMA, type Card, type ExplainMode, type Grade, type Plan, type Question, type Test,
} from "./ai/prompts";
import { CONTEXT, offsetOf, textIndex } from "./notes/anchor";
import { body, el, emit, getJSON, isTyping, newId, removeKey, renderMath, sectionOf, setJSON, STORE } from "./util";

const chapters = chaptersOnPage();
const onCourse = chapters.length > 0;
const courseSlug = body.dataset.course || "site";
const courseName = body.dataset.pageTitle || document.title;
const key = (name: string) => `${STORE}ai:${name}:${courseSlug}`;
const SETTINGS = STORE + "ai:settings";

const DEFAULTS: AiSettings = { provider: "anthropic", model: "claude-opus-5-5", apiKey: "", baseUrl: "", maxContext: 400000 };
let settings: AiSettings = { ...DEFAULTS, ...getJSON<Partial<AiSettings>>(SETTINGS, {}) };
const configured = () => !!settings.model && (settings.provider === "openai" || !!settings.apiKey);
const current = (): Chapter | null => chapters.find((c) => c.section === window.currentChapter) || chapters[0] || null;

// ---------------------------------------------------------------- panel

const panel = el("aside", { class: "notes-panel ai-panel hl-ignore", id: "ai-panel", "aria-label": "AI study tools" });
const tabs: Record<string, { button: HTMLButtonElement; view: HTMLElement }> = {};
const head = el("div", { class: "notes-tabs" });
for (const [id, label] of [["ask", "Ask"], ["test", "Test"], ["study", "Study"], ["settings", "⚙"]] as const) {
  const button = el("button", { class: "notes-tab", text: label, onclick: () => showTab(id) });
  if (id === "settings") button.setAttribute("aria-label", "AI settings");
  const view = el("div", { class: "notes-view ai-view", hidden: "" });
  tabs[id] = { button, view };
  head.appendChild(button);
}
panel.append(
  el("div", { class: "notes-head" }, [head, el("button", { class: "icon-btn", "aria-label": "Close AI", html: "&times;", onclick: () => togglePanel(false) })]),
  ...Object.values(tabs).map((t) => t.view),
  el("div", { class: "notes-foot", text: "Your model, your key: requests go straight from this browser to the provider you chose." }),
);
document.body.appendChild(panel);

let activeTab = "ask";
function showTab(id: string): void {
  activeTab = id;
  for (const [name, t] of Object.entries(tabs)) {
    t.button.classList.toggle("active", name === id);
    t.view.hidden = name !== id;
  }
  if (!configured() && id !== "settings") renderNeedsSetup(tabs[id].view);
  else ({ ask: renderAsk, test: renderTests, study: renderStudy, settings: renderSettings } as Record<string, () => void>)[id]?.();
}

function togglePanel(open?: boolean): void {
  const show = open ?? !body.classList.contains("ai-open");
  body.classList.toggle("ai-open", show);
  if (show) {
    if (body.classList.contains("notes-open")) document.getElementById("notes-toggle")?.click();
    showTab(activeTab);
  }
}

document.getElementById("ai-toggle")?.addEventListener("click", () => togglePanel());
document.addEventListener("notes:panel", (e) => { if (e.detail.open) togglePanel(false); });
document.addEventListener("keydown", (e) => {
  if (isTyping(e)) return;
  if (e.key === "i") { e.preventDefault(); togglePanel(); }
  else if (e.key === "Escape" && body.classList.contains("ai-open")) togglePanel(false);
});

/** Children for replaceChildren, skipping the optional ones that are null. */
function nodes(...xs: (Node | null | undefined)[]): Node[] {
  return xs.filter((x): x is Node => !!x);
}

function renderNeedsSetup(view: HTMLElement): void {
  view.replaceChildren(
    el("p", { class: "ai-lead", text: "Bring your own model to ask questions about your notes, generate practice tests, and study with flashcards and a plan." }),
    el("p", { class: "notes-tip", text: "Pick a provider and model and add your API key. It is stored only in this browser." }),
    el("button", { class: "small-btn primary", text: "Set up AI", onclick: () => showTab("settings") }),
  );
}

function needsCourse(view: HTMLElement): boolean {
  if (onCourse) return false;
  view.replaceChildren(el("p", { class: "notes-tip", text: "Open one of the collections to use the AI tools on its notes." }));
  return true;
}

function setHtml(node: HTMLElement, markdown: string, refs: ChapterRef[] = chapters): void {
  node.innerHTML = renderMarkdown(markdown, refs);
  renderMath(node);
}

function errorBox(e: unknown): HTMLElement {
  return el("div", { class: "ai-error", text: (e as Error).name === "AbortError" ? "Stopped." : (e as Error).message || String(e) });
}

function truncationNote(ctx: Context): HTMLElement | null {
  return ctx.truncated
    ? el("p", { class: "ai-warn", text: `These notes are longer than the context limit (${settings.maxContext.toLocaleString()} characters), so only the start of each chapter was sent. Pick fewer chapters, or raise the limit in settings.` })
    : null;
}

/** Run a request with a progress line and a Stop button; resolves to the text or throws. */
async function withProgress(host: HTMLElement, label: string, run: (signal: AbortSignal, onText: (d: string) => void) => Promise<string>): Promise<string> {
  const ctrl = new AbortController();
  let chars = 0;
  const status = el("span", { class: "ai-status", text: label + "…" });
  const row = el("div", { class: "ai-progress" }, [el("span", { class: "ai-spinner" }), status,
    el("button", { class: "link-btn", text: "Stop", onclick: () => ctrl.abort() })]);
  host.appendChild(row);
  try {
    return await run(ctrl.signal, (d) => {
      chars += d.length;
      status.textContent = `${label}… ${chars.toLocaleString()} characters`;
    });
  } finally {
    row.remove();
  }
}

// ---------------------------------------------------------------- scope picker

interface Scope { element: HTMLElement; chosen(): Chapter[] }

function scopePicker(): Scope {
  const select = el("select", { class: "ai-input" }, [
    el("option", { value: "current", text: "The chapter I'm reading" }),
    el("option", { value: "pick", text: "Chapters I choose…" }),
    el("option", { value: "all", text: "The whole course" }),
  ]);
  const boxes = el("div", { class: "ai-chapters", hidden: "" });
  for (const c of chapters) {
    boxes.appendChild(el("label", { class: "ai-check" }, [el("input", { type: "checkbox", value: c.slug }), document.createTextNode(" " + c.title)]));
  }
  select.addEventListener("change", () => { boxes.hidden = select.value !== "pick"; });
  return {
    element: el("div", { class: "ai-field" }, [el("label", { class: "ai-label", text: "From" }), select, boxes]),
    chosen() {
      if (select.value === "all") return chapters;
      if (select.value === "pick") {
        const slugs = new Set(Array.from(boxes.querySelectorAll<HTMLInputElement>("input:checked")).map((i) => i.value));
        return chapters.filter((c) => slugs.has(c.slug));
      }
      const c = current();
      return c ? [c] : [];
    },
  };
}

// ---------------------------------------------------------------- ask + explain

interface Turn extends ChatMessage { quote?: string; anchor?: Anchor; html?: HTMLElement }
interface Anchor { pageId: string; exact: string; prefix: string; suffix: string }

const conversation: Turn[] = [];
const thread = el("div", { class: "ai-thread" });
const askInput = el("textarea", { class: "ai-input", rows: "3", placeholder: "Ask about your notes… (Enter to send, Shift+Enter for a new line)" });

function renderAsk(): void {
  const view = tabs.ask.view;
  if (needsCourse(view)) return;
  if (!view.contains(thread)) {
    view.replaceChildren(
      el("p", { class: "notes-tip", text: "Answers use the chapter you're reading and the chapters most related to your question. Select text in the notes and press “Ask AI” to explain it." }),
      thread, askInput,
      el("div", { class: "ai-actions" }, [
        el("button", { class: "link-btn", text: "Clear", onclick: () => { conversation.length = 0; thread.replaceChildren(); } }),
        el("button", { class: "small-btn primary", text: "Ask", onclick: () => void ask() }),
      ]),
    );
  }
  askInput.focus();
}

askInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(); }
});

function addTurn(turn: Turn): HTMLElement {
  const bubble = el("div", { class: `ai-turn ai-${turn.role}` });
  if (turn.quote) bubble.appendChild(el("blockquote", { class: "ai-quote", text: turn.quote }));
  const content = el("div", { class: "ai-content" });
  if (turn.role === "user") content.textContent = turn.content; else setHtml(content, turn.content);
  bubble.appendChild(content);
  thread.appendChild(bubble);
  turn.html = content;
  conversation.push(turn);
  bubble.scrollIntoView({ block: "end" });
  return bubble;
}

async function respond(system: string, ctx: Context, anchor?: Anchor): Promise<void> {
  const reply: Turn = { role: "assistant", content: "" };
  const bubble = addTurn(reply);
  const note = truncationNote(ctx);
  if (note) bubble.prepend(note);
  // Keep the request bounded: the last few exchanges plus the notes.
  const history = conversation.slice(0, -1).slice(-8).map((t) => ({ role: t.role, content: t.content }));
  try {
    await withProgress(bubble, "Thinking", async (signal, onText) => chat(settings, {
      system: `${system}\n\n<notes>\n${ctx.text}\n</notes>`,
      messages: history,
      signal,
      maxTokens: 16000,
      onText: (d) => {
        onText(d);
        reply.content += d;
        setHtml(reply.html!, reply.content, ctx.refs);
      },
    }));
    if (anchor && reply.content) {
      bubble.appendChild(el("div", { class: "ai-actions" }, [el("button", {
        class: "small-btn", text: "Keep as margin note",
        onclick: (e) => {
          emit("notes:add-highlight", { ...anchor, comment: reply.content });
          (e.currentTarget as HTMLButtonElement).replaceWith(el("span", { class: "muted small", text: "Saved to your highlights (n)." }));
        },
      })]));
    }
  } catch (e) {
    bubble.appendChild(errorBox(e));
    conversation.pop();
  }
}

async function ask(): Promise<void> {
  const q = askInput.value.trim();
  if (!q) return;
  askInput.value = "";
  addTurn({ role: "user", content: q });
  const ctx = contextForQuestion(q, current(), chapters, settings.maxContext);
  await respond(askSystem(courseName), ctx);
}

/** "Ask AI" on a selection: explain it, with buttons for the other modes. */
function explain(quote: string, section: HTMLElement, anchor: Anchor | undefined, mode: ExplainMode = "explain"): void {
  if (!configured()) { togglePanel(true); showTab("settings"); return; }
  showTab("ask");
  togglePanel(true);
  const prompt = explainPrompt(mode, quote);
  const turn = addTurn({ role: "user", content: prompt, quote, anchor });
  turn.querySelector(".ai-content")!.textContent = EXPLAIN_LABELS[mode];
  const others = el("div", { class: "ai-modes" });
  for (const m of Object.keys(EXPLAIN_LABELS) as ExplainMode[]) {
    if (m !== mode) others.appendChild(el("button", { class: "chip", text: EXPLAIN_LABELS[m], onclick: () => explain(quote, section, anchor, m) }));
  }
  turn.appendChild(others);
  const ch = chapters.find((c) => c.section === section) || current();
  void respond(askSystem(courseName), contextFor(ch ? [ch] : [], settings.maxContext), anchor);
}

function anchorOf(range: Range, section: HTMLElement): Anchor | undefined {
  const root = section.querySelector<HTMLElement>(".chapter-body");
  if (!root) return undefined;
  const index = textIndex(root);
  let start = offsetOf(index, range.startContainer, range.startOffset);
  let end = offsetOf(index, range.endContainer, range.endOffset);
  if (start < 0 || end <= start) return undefined;
  const raw = index.text.slice(start, end);
  start += raw.length - raw.replace(/^\s+/, "").length;
  end -= raw.length - raw.replace(/\s+$/, "").length;
  return {
    pageId: section.dataset.pageId || "", exact: index.text.slice(start, end),
    prefix: index.text.slice(Math.max(0, start - CONTEXT), start), suffix: index.text.slice(end, end + CONTEXT),
  };
}

// The highlight toolbar (notes.js) gets an "Ask AI" button.
const toolbar = document.querySelector<HTMLElement>(".hl-toolbar");
if (toolbar && onCourse) {
  toolbar.appendChild(el("button", {
    class: "hl-ai-btn", text: "✨ Ask AI", title: "Explain this with your AI model (i)",
    onmousedown: (e) => {
      e.preventDefault();
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      const section = sectionOf(range.startContainer);
      if (!section) return;
      const quote = range.toString().trim();
      const anchor = anchorOf(range, section);
      toolbar.classList.remove("open");
      sel.removeAllRanges();
      explain(quote, section, anchor);
    },
  }));
}

// ---------------------------------------------------------------- practice tests

interface Attempt { date: string; score: number; answers: string[]; grades: (Grade | null)[] }
interface SavedTest extends Test { id: string; created: string; request: string; attempts: Attempt[] }

const loadTests = () => getJSON<SavedTest[]>(key("tests"), []);
const saveTests = (t: SavedTest[]) => setJSON(key("tests"), t);

function renderTests(): void {
  const view = tabs.test.view;
  if (needsCourse(view)) return;
  const scope = scopePicker();
  const request = el("textarea", { class: "ai-input", rows: "3", placeholder: "What should the test look like? e.g. “12 questions at final-exam difficulty, mostly multiple choice, two proofs, focus on hashing”" });
  const out = el("div");
  const generate = el("button", { class: "small-btn primary", text: "Write test" });
  generate.addEventListener("click", async () => {
    const picked = scope.chosen();
    if (!picked.length) { out.replaceChildren(errorBox(new Error("Choose at least one chapter."))); return; }
    const ctx = contextFor(picked, settings.maxContext);
    out.replaceChildren();
    const note = truncationNote(ctx);
    if (note) out.appendChild(note);
    generate.disabled = true;
    try {
      const text = await withProgress(out, "Writing questions", (signal, onText) => chat(settings, {
        system: `${testSystem(courseName)}\n\n<notes>\n${ctx.text}\n</notes>`,
        messages: [{ role: "user", content: request.value.trim() || "A 10-question practice test with a mix of question types and difficulties." }],
        schema: TEST_SCHEMA, signal, onText,
      }));
      const test = parseJson<Test>(text);
      if (!test.questions?.length) throw new Error("The model returned no questions.");
      const saved: SavedTest = { ...test, id: newId(), created: new Date().toISOString(), request: request.value.trim(), attempts: [] };
      saveTests([saved, ...loadTests()]);
      takeTest(saved);
    } catch (e) {
      out.appendChild(errorBox(e));
    } finally {
      generate.disabled = false;
    }
  });
  const list = el("div", { class: "hl-list" });
  for (const t of loadTests()) {
    const best = t.attempts.length ? Math.max(...t.attempts.map((a) => a.score)) : null;
    list.appendChild(el("div", { class: "ai-item", onclick: () => takeTest(t) }, [
      el("span", { class: "all-title", text: t.title }),
      el("span", { class: "muted small", text: `${t.questions.length} questions · ${new Date(t.created).toLocaleDateString()}` +
        (best != null ? ` · best ${Math.round(best * 100)}%` : " · not taken") }),
    ]));
  }
  view.replaceChildren(...nodes(
    el("p", { class: "notes-tip", text: "Describe the test you want; it is written from your notes and graded with explanations." }),
    scope.element, el("div", { class: "ai-field" }, [el("label", { class: "ai-label", text: "Request" }), request]),
    el("div", { class: "ai-actions" }, [generate]), out,
    list.childElementCount ? el("div", { class: "notes-section-title", text: "Your tests" }) : null, list,
  ));
}

function takeTest(test: SavedTest): void {
  const view = tabs.test.view;
  const inputs: (() => string)[] = [];
  const items = test.questions.map((q, i) => {
    const box = el("div", { class: "ai-question" });
    const prompt = el("div", { class: "ai-content" });
    setHtml(prompt, `**${i + 1}.** ${q.prompt}`);
    box.appendChild(prompt);
    if (q.choices.length) {
      const name = `q${test.id}-${i}`;
      for (const c of q.choices) {
        const label = el("label", { class: "ai-choice" }, [el("input", { type: "radio", name, value: c })]);
        const text = el("span");
        setHtml(text, c);
        label.appendChild(text);
        box.appendChild(label);
      }
      inputs.push(() => box.querySelector<HTMLInputElement>("input:checked")?.value ?? "");
    } else {
      const area = el("textarea", { class: "ai-input", rows: q.type === "numeric" ? "1" : "3", placeholder: q.type === "numeric" ? "Your answer (a number)" : "Your answer" });
      box.appendChild(area);
      inputs.push(() => area.value.trim());
    }
    return box;
  });
  const result = el("div");
  const submit = el("button", { class: "small-btn primary", text: "Submit answers" });
  submit.addEventListener("click", async () => {
    submit.disabled = true;
    try {
      await grade(test, inputs.map((f) => f()), items, result);
      submit.remove();
    } catch (e) {
      result.replaceChildren(errorBox(e));
      submit.disabled = false;
    }
  });
  view.replaceChildren(
    el("button", { class: "link-btn", text: "← All tests", onclick: () => renderTests() }),
    el("h3", { class: "ai-title", text: test.title }),
    ...items,
    el("div", { class: "ai-actions" }, [
      el("button", { class: "link-btn danger", text: "Delete test", onclick: () => { saveTests(loadTests().filter((t) => t.id !== test.id)); renderTests(); } }),
      submit,
    ]),
    result,
  );
  view.scrollTop = 0;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[$\s.,;:!?'"`*]/g, "");
}

function autoGrade(q: Question, answer: string): number | null {
  if (q.type === "mcq" || q.type === "true_false") return norm(answer) === norm(q.answer) ? 1 : 0;
  if (q.type === "numeric") {
    const a = parseFloat(answer.replace(/,/g, "")), b = parseFloat(q.answer.replace(/,/g, ""));
    if (Number.isNaN(a) || Number.isNaN(b)) return norm(answer) === norm(q.answer) ? 1 : 0;
    return Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-3) ? 1 : 0;
  }
  return null; // short answers are graded by the model
}

async function grade(test: SavedTest, answers: string[], items: HTMLElement[], result: HTMLElement): Promise<void> {
  const scores = test.questions.map((q, i) => (answers[i] ? autoGrade(q, answers[i]) : 0));
  const grades: (Grade | null)[] = test.questions.map(() => null);
  const open = test.questions.map((q, i) => ({ q, i })).filter(({ i }) => scores[i] === null);
  if (open.length) {
    const ctx = contextFor(chapters.filter((c) => open.some(({ q }) => q.chapter === c.slug)), settings.maxContext);
    const listing = open.map(({ q, i }) => `Question ${i}: ${q.prompt}\nModel answer: ${q.answer}\nStudent answer: ${answers[i] || "(blank)"}`).join("\n\n");
    const text = await withProgress(result, "Grading", (signal, onText) => chat(settings, {
      system: `${gradeSystem()}\n\n<notes>\n${ctx.text}\n</notes>`,
      messages: [{ role: "user", content: listing }], schema: GRADE_SCHEMA, signal, onText,
    }));
    for (const g of parseJson<{ results: Grade[] }>(text).results) {
      if (g.index >= 0 && g.index < scores.length && scores[g.index] === null) {
        scores[g.index] = Math.max(0, Math.min(1, g.score));
        grades[g.index] = g;
      }
    }
  }
  const final = scores.map((s) => s ?? 0);
  const total = final.reduce((a, b) => a + b, 0) / final.length;
  test.questions.forEach((q, i) => {
    const s = final[i];
    const fb = el("div", { class: `ai-feedback ${s >= 0.99 ? "ok" : s > 0 ? "part" : "bad"}` });
    const ch = chapters.find((c) => c.slug === q.chapter);
    setHtml(fb, `**${s >= 0.99 ? "Correct" : s > 0 ? `Partly right (${Math.round(s * 100)}%)` : "Not quite"}.** ` +
      (grades[i]?.feedback ? grades[i]!.feedback + "\n\n" : "") +
      (q.type !== "short" ? `Answer: ${q.answer}\n\n` : `Model answer: ${q.answer}\n\n`) + q.explanation +
      (ch ? ` [[${ch.slug}]]` : ""));
    items[i].appendChild(fb);
  });
  result.replaceChildren(el("div", { class: "ai-score" }, [
    el("strong", { text: `Score: ${Math.round(total * 100)}%` }),
    el("button", { class: "small-btn", text: "Retake", onclick: () => takeTest(test) }),
  ]));
  const all = loadTests();
  const saved = all.find((t) => t.id === test.id);
  if (saved) {
    saved.attempts.push({ date: new Date().toISOString(), score: total, answers, grades });
    saveTests(all);
  }
}

// ---------------------------------------------------------------- study: flashcards + plan

interface DeckCard extends Card { id: string; due: number; interval: number; ease: number; reps: number }
const DAY = 86400000;
const loadDeck = () => getJSON<DeckCard[]>(key("deck"), []);
const saveDeck = (d: DeckCard[]) => setJSON(key("deck"), d);

/** Spaced repetition (SM-2 style): the better you know a card, the longer until you see it again. */
function schedule(card: DeckCard, grade: 0 | 1 | 2 | 3): void {
  const now = Date.now();
  if (grade === 0) {
    card.reps = 0;
    card.interval = 0;
    card.ease = Math.max(1.3, card.ease - 0.2);
    card.due = now + 10 * 60000;
    return;
  }
  if (grade === 1) card.interval = Math.max(1, card.interval * 1.2);
  else if (card.reps === 0) card.interval = grade === 3 ? 3 : 1;
  else if (card.reps === 1) card.interval = grade === 3 ? 6 : 3;
  else card.interval = card.interval * card.ease * (grade === 3 ? 1.3 : 1);
  card.ease = Math.max(1.3, card.ease + (grade === 1 ? -0.15 : grade === 3 ? 0.15 : 0));
  card.reps++;
  card.due = now + Math.round(card.interval) * DAY;
}

function renderStudy(): void {
  const view = tabs.study.view;
  if (needsCourse(view)) return;
  const deck = loadDeck();
  const due = deck.filter((c) => c.due <= Date.now());
  const scope = scopePicker();
  const request = el("textarea", { class: "ai-input", rows: "2", placeholder: "e.g. “25 cards on definitions and theorems”" });
  const cardsOut = el("div");
  const makeCards = el("button", { class: "small-btn primary", text: "Make flashcards" });
  makeCards.addEventListener("click", async () => {
    const picked = scope.chosen();
    if (!picked.length) { cardsOut.replaceChildren(errorBox(new Error("Choose at least one chapter."))); return; }
    const ctx = contextFor(picked, settings.maxContext);
    cardsOut.replaceChildren();
    const note = truncationNote(ctx);
    if (note) cardsOut.appendChild(note);
    makeCards.disabled = true;
    try {
      const text = await withProgress(cardsOut, "Writing cards", (signal, onText) => chat(settings, {
        system: `${cardsSystem(courseName)}\n\n<notes>\n${ctx.text}\n</notes>`,
        messages: [{ role: "user", content: request.value.trim() || "20 flashcards covering the key ideas." }],
        schema: CARDS_SCHEMA, signal, onText,
      }));
      const cards = parseJson<{ cards: Card[] }>(text).cards || [];
      const now = Date.now();
      saveDeck([...loadDeck(), ...cards.map((c) => ({ ...c, id: newId(), due: now, interval: 0, ease: 2.5, reps: 0 }))]);
      renderStudy();
    } catch (e) {
      cardsOut.appendChild(errorBox(e));
    } finally {
      makeCards.disabled = false;
    }
  });

  view.replaceChildren(...nodes(
    el("div", { class: "notes-section-title", text: "Flashcards" }),
    el("p", { class: "ai-lead", text: deck.length ? `${deck.length} cards, ${due.length} due now.` : "No flashcards yet." }),
    due.length ? el("button", { class: "small-btn primary", text: `Review ${due.length} card${due.length === 1 ? "" : "s"}`, onclick: () => review() }) : null,
    scope.element, el("div", { class: "ai-field" }, [el("label", { class: "ai-label", text: "Request" }), request]),
    el("div", { class: "ai-actions" }, [
      deck.length ? el("button", { class: "link-btn danger", text: "Delete all cards", onclick: () => { if (confirm("Delete every flashcard for this course?")) { removeKey(key("deck")); renderStudy(); } } }) : el("span"),
      makeCards,
    ]),
    cardsOut,
    el("div", { class: "notes-section-title", text: "Study plan" }),
    planSection(),
  ));
}

function review(): void {
  const view = tabs.study.view;
  const deck = loadDeck();
  const queue = deck.filter((c) => c.due <= Date.now()).sort((a, b) => a.due - b.due);
  let done = 0;
  const show = () => {
    const card = queue.shift();
    if (!card) {
      view.replaceChildren(el("p", { class: "ai-lead", text: `Done: ${done} card${done === 1 ? "" : "s"} reviewed.` }),
        el("button", { class: "small-btn", text: "Back", onclick: () => renderStudy() }));
      return;
    }
    const front = el("div", { class: "ai-card-face" });
    setHtml(front, card.front);
    const back = el("div", { class: "ai-card-face back", hidden: "" });
    const ch = chapters.find((c) => c.slug === card.chapter);
    setHtml(back, card.back + (ch ? ` [[${ch.slug}]]` : ""));
    const grades = el("div", { class: "ai-grades", hidden: "" });
    ([["Again", 0], ["Hard", 1], ["Good", 2], ["Easy", 3]] as const).forEach(([label, g]) => {
      grades.appendChild(el("button", { class: "small-btn", text: label, onclick: () => {
        const all = loadDeck();
        const stored = all.find((c) => c.id === card.id);
        if (stored) { schedule(stored, g); saveDeck(all); if (g === 0) queue.push(stored); }
        done++;
        show();
      } }));
    });
    const reveal = el("button", { class: "small-btn primary", text: "Show answer", onclick: () => { back.hidden = false; grades.hidden = false; reveal.remove(); } });
    view.replaceChildren(
      el("button", { class: "link-btn", text: "← Stop reviewing", onclick: () => renderStudy() }),
      el("p", { class: "muted small", text: `${queue.length + 1} left` }),
      el("div", { class: "ai-card" }, [front, back]), reveal, grades,
    );
  };
  show();
}

interface SavedPlan extends Plan { done: Record<string, boolean>; created: string }

function planSection(): HTMLElement {
  const wrap = el("div");
  const plan = getJSON<SavedPlan | null>(key("plan"), null);
  if (plan) {
    const today = new Date().toISOString().slice(0, 10);
    const summary = el("div", { class: "ai-content" });
    setHtml(summary, plan.summary);
    wrap.append(summary);
    for (const day of plan.days) {
      const box = el("div", { class: `ai-day${day.date === today ? " today" : ""}${day.date < today ? " past" : ""}` }, [
        el("div", { class: "ai-day-head" }, [el("strong", { text: new Date(day.date + "T12:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) }), el("span", { class: "muted small", text: day.focus })]),
      ]);
      day.tasks.forEach((t, i) => {
        const id = `${day.date}-${i}`;
        const check = el("input", { type: "checkbox" });
        check.checked = !!plan.done[id];
        check.addEventListener("change", () => { plan.done[id] = check.checked; setJSON(key("plan"), plan); });
        const ch = chapters.find((c) => c.slug === t.chapter);
        const label = el("label", { class: "ai-check" }, [check, el("span", { text: ` ${t.task} (${t.minutes} min)` })]);
        if (ch) label.appendChild(el("a", { class: "ai-cite", href: `#${ch.slug}`, text: ch.title }));
        box.appendChild(label);
      });
      wrap.appendChild(box);
    }
    wrap.appendChild(el("div", { class: "ai-actions" }, [el("button", { class: "link-btn danger", text: "Delete plan", onclick: () => { removeKey(key("plan")); renderStudy(); } })]));
    return wrap;
  }
  const date = el("input", { class: "ai-input", type: "date" });
  const hours = el("input", { class: "ai-input", type: "number", min: "0.5", step: "0.5", value: "2" });
  const wants = el("textarea", { class: "ai-input", rows: "2", placeholder: "e.g. “final on everything, weak at chapters 7–9, no studying on Sundays”" });
  const out = el("div");
  const make = el("button", { class: "small-btn primary", text: "Make plan" });
  make.addEventListener("click", async () => {
    if (!date.value) { out.replaceChildren(errorBox(new Error("Pick the exam or deadline date."))); return; }
    const ctx = contextFor(chapters, Math.min(settings.maxContext, 60000));
    const today = new Date().toISOString().slice(0, 10);
    make.disabled = true;
    out.replaceChildren();
    try {
      const text = await withProgress(out, "Planning", (signal, onText) => chat(settings, {
        system: `${planSystem(courseName, today)}\n\n<notes>\n${ctx.text}\n</notes>`,
        messages: [{ role: "user", content: `Deadline: ${date.value}. Time per day: ${hours.value} hours. ${wants.value.trim()}` }],
        schema: PLAN_SCHEMA, signal, onText,
      }));
      const p = parseJson<Plan>(text);
      setJSON(key("plan"), { ...p, done: {}, created: new Date().toISOString() });
      renderStudy();
    } catch (e) {
      out.appendChild(errorBox(e));
    } finally {
      make.disabled = false;
    }
  });
  wrap.append(
    el("p", { class: "notes-tip", text: "A day-by-day plan up to your exam, built from these notes." }),
    el("div", { class: "ai-field" }, [el("label", { class: "ai-label", text: "Exam or deadline" }), date]),
    el("div", { class: "ai-field" }, [el("label", { class: "ai-label", text: "Hours per day" }), hours]),
    el("div", { class: "ai-field" }, [el("label", { class: "ai-label", text: "Anything else" }), wants]),
    el("div", { class: "ai-actions" }, [make]), out,
  );
  return wrap;
}

// ---------------------------------------------------------------- settings

function renderSettings(): void {
  const view = tabs.settings.view;
  const provider = el("select", { class: "ai-input" });
  for (const [id, p] of Object.entries(PROVIDERS)) provider.appendChild(el("option", { value: id, text: p.label }));
  provider.value = settings.provider;
  const model = el("input", { class: "ai-input", list: "ai-models", spellcheck: "false" });
  const models = el("datalist", { id: "ai-models" });
  const apiKey = el("input", { class: "ai-input", type: "password", autocomplete: "off", spellcheck: "false", placeholder: "API key" });
  const baseUrl = el("input", { class: "ai-input", spellcheck: "false" });
  const maxContext = el("input", { class: "ai-input", type: "number", min: "10000", step: "10000" });
  const help = el("p", { class: "notes-tip" });
  const status = el("div");
  const sync = () => {
    const p = PROVIDERS[provider.value as ProviderId];
    model.placeholder = p.placeholder;
    models.replaceChildren(...p.models.map((m) => el("option", { value: m })));
    help.textContent = p.keyHelp;
    baseUrl.placeholder = provider.value === "openai" ? "https://api.openai.com/v1" : "Default endpoint";
  };
  model.value = settings.model;
  apiKey.value = settings.apiKey;
  baseUrl.value = settings.baseUrl;
  maxContext.value = String(settings.maxContext);
  provider.addEventListener("change", () => {
    sync();
    const p = PROVIDERS[provider.value as ProviderId];
    model.value = p.models[0] || "";
  });
  sync();
  const read = (): AiSettings => ({
    provider: provider.value as ProviderId, model: model.value.trim(), apiKey: apiKey.value.trim(),
    baseUrl: baseUrl.value.trim(), maxContext: Math.max(10000, Number(maxContext.value) || DEFAULTS.maxContext),
  });
  view.replaceChildren(
    el("p", { class: "ai-lead", text: "Bring your own model. Everything you set here stays in this browser." }),
    el("div", { class: "ai-field" }, [el("label", { class: "ai-label", text: "Provider" }), provider]),
    el("div", { class: "ai-field" }, [el("label", { class: "ai-label", text: "Model" }), model, models]),
    el("div", { class: "ai-field" }, [el("label", { class: "ai-label", text: "API key" }), apiKey, help]),
    el("div", { class: "ai-field" }, [el("label", { class: "ai-label", text: "Endpoint (optional)" }), baseUrl]),
    el("div", { class: "ai-field" }, [el("label", { class: "ai-label", text: "Most characters of notes per request" }), maxContext]),
    el("div", { class: "ai-actions" }, [
      el("button", { class: "link-btn danger", text: "Forget key", onclick: () => { apiKey.value = ""; settings = { ...read() }; setJSON(SETTINGS, settings); status.replaceChildren(el("span", { class: "muted small", text: "Key removed from this browser." })); } }),
      el("button", { class: "small-btn", text: "Test", onclick: async () => {
        settings = read();
        setJSON(SETTINGS, settings);
        status.replaceChildren();
        try {
          const reply = await withProgress(status, "Testing", (signal) => chat(settings, {
            system: "Reply with exactly: OK", messages: [{ role: "user", content: "Are you there?" }], maxTokens: 2000, signal,
          }));
          status.replaceChildren(el("span", { class: "ai-ok", text: `Connected: ${reply.trim().slice(0, 60) || "OK"}` }));
        } catch (e) {
          status.replaceChildren(errorBox(e));
        }
      } }),
      el("button", { class: "small-btn primary", text: "Save", onclick: () => { settings = read(); setJSON(SETTINGS, settings); showTab("ask"); } }),
    ]),
    status,
    el("p", { class: "notes-tip", text: "Your key is sent only to the provider you choose, straight from this browser. Use a key with a spending limit, and don't save it on a shared computer." }),
  );
}

showTab(activeTab);
