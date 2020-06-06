// What the model is asked to do, and the JSON shapes it answers in. Every
// object lists all its properties as required with additionalProperties false,
// so the schemas work with strict structured output on every provider.

const str = { type: "string" };
const int = { type: "integer" };
const num = { type: "number" };
const obj = (properties: Record<string, unknown>) => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
});
const arr = (items: unknown) => ({ type: "array", items });

export type QuestionType = "mcq" | "true_false" | "short" | "numeric";

export interface Question {
  type: QuestionType;
  prompt: string;
  choices: string[];
  answer: string;
  explanation: string;
  chapter: string;
  difficulty: "easy" | "medium" | "hard";
}
export interface Test { title: string; questions: Question[] }

export const TEST_SCHEMA = obj({
  title: str,
  questions: arr(obj({
    type: { type: "string", enum: ["mcq", "true_false", "short", "numeric"] },
    prompt: str,
    choices: arr(str),
    answer: str,
    explanation: str,
    chapter: str,
    difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
  })),
});

export interface Grade { index: number; score: number; feedback: string }
export const GRADE_SCHEMA = obj({ results: arr(obj({ index: int, score: num, feedback: str })) });

export interface Card { front: string; back: string; chapter: string }
export const CARDS_SCHEMA = obj({ cards: arr(obj({ front: str, back: str, chapter: str })) });

export interface PlanTask { task: string; chapter: string; minutes: number }
export interface PlanDay { date: string; focus: string; tasks: PlanTask[] }
export interface Plan { summary: string; days: PlanDay[] }
export const PLAN_SCHEMA = obj({
  summary: str,
  days: arr(obj({ date: str, focus: str, tasks: arr(obj({ task: str, chapter: str, minutes: int })) })),
});

const NOTES_RULES = `The notes are the reader's own course notes. Each chapter starts with a header "### [[slug]] Title".
Write math as LaTeX between $...$ (inline) or $$...$$ (display). Base everything on the notes; where you add
knowledge that is not in them, say so.`;

export function testSystem(course: string): string {
  return `You write practice tests for a student studying "${course}" from their notes.
${NOTES_RULES}
Follow the student's request for the number, kind and difficulty of questions. For every question:
- "chapter" is the slug of the chapter it tests (from the [[slug]] headers);
- for "mcq" give 4 choices and set "answer" to the exact text of the correct choice;
- for "true_false" set choices to ["True", "False"] and "answer" to one of them;
- for "numeric" give the exact numeric answer as "answer" and choices as [];
- for "short" give a model answer in "answer" and choices as [];
- "explanation" explains why the answer is right, referring to the notes.
Test understanding and application, not trivia; vary the questions; never repeat one.`;
}

export function gradeSystem(): string {
  return `You grade a student's written answers to a practice test built from their notes.
For each answer give "score" from 0 to 1 (partial credit allowed) and short, specific "feedback": what is right,
what is missing or wrong, and what to review. "index" is the question number given. ${NOTES_RULES}`;
}

export function cardsSystem(course: string): string {
  return `You make flashcards for spaced-repetition study of "${course}" from the student's notes.
${NOTES_RULES}
Each card tests one idea: a definition, theorem, formula, step of an algorithm, or a "why" question. Keep the
front a short question and the back a concise, complete answer. "chapter" is the slug of the chapter the card comes from.`;
}

export function planSystem(course: string, today: string): string {
  return `You make a day-by-day study plan for "${course}" from the student's notes. Today is ${today}.
${NOTES_RULES}
Respect the student's dates, hours and priorities. Spread chapters sensibly, schedule review and practice tests
before the deadline, and keep each day within the time they give. Dates are YYYY-MM-DD. "chapter" is a chapter
slug from the notes, or "" for a task that is not about one chapter.`;
}

export function askSystem(course: string): string {
  return `You are a study assistant for "${course}". Answer the student's questions from their notes.
${NOTES_RULES}
Cite the chapters you used by writing their [[slug]] after the sentence. If the notes do not cover something,
say so before answering from general knowledge. Be clear and concise; use short paragraphs, lists and worked examples.`;
}

export type ExplainMode = "explain" | "simpler" | "example" | "summarize";

export const EXPLAIN_LABELS: Record<ExplainMode, string> = {
  explain: "Explain", simpler: "Simpler", example: "Example", summarize: "Summarize",
};

export function explainPrompt(mode: ExplainMode, quote: string): string {
  const task = {
    explain: "Explain this passage from my notes clearly, filling in the steps a student might miss.",
    simpler: "Explain this passage from my notes in simpler words, as if to someone seeing it for the first time.",
    example: "Give a worked example that illustrates this passage from my notes.",
    summarize: "Summarize this passage from my notes in a few bullet points.",
  }[mode];
  return `${task}\n\nPassage:\n"""\n${quote}\n"""`;
}
