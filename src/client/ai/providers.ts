// "Bring your own model": the reader's provider, model and key, kept in this
// browser only. Requests go straight from the browser to the provider.
import { rootUrl } from "../util";

export type ProviderId = "anthropic" | "openai" | "gemini";

export interface AiSettings {
  provider: ProviderId;
  model: string;
  apiKey: string;
  /** OpenAI-compatible endpoints (Ollama, LM Studio, OpenRouter, Groq...). */
  baseUrl: string;
  /** Most characters of notes sent in one request. */
  maxContext: number;
}

export interface ChatMessage { role: "user" | "assistant"; content: string }

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  /** Ask for JSON matching this schema (structured output where the provider supports it). */
  schema?: Record<string, unknown>;
  maxTokens?: number;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
}

export const PROVIDERS: Record<ProviderId, { label: string; models: string[]; placeholder: string; keyHelp: string }> = {
  anthropic: {
    label: "Anthropic (Claude)",
    models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    placeholder: "claude-opus-5-5",
    keyHelp: "Create a key at console.anthropic.com.",
  },
  openai: {
    label: "OpenAI or compatible (Ollama, LM Studio, OpenRouter, Groq…)",
    models: [],
    placeholder: "model name, e.g. the one your server lists",
    keyHelp: "Leave the key empty for local servers such as Ollama (http://localhost:11434/v1).",
  },
  gemini: {
    label: "Google Gemini",
    models: [],
    placeholder: "a Gemini model name",
    keyHelp: "Create a key in Google AI Studio.",
  },
};

export class AiError extends Error {}

/** One request to the configured model; streams text through onText and returns all of it. */
export async function chat(s: AiSettings, req: ChatRequest): Promise<string> {
  if (!s.model) throw new AiError("Choose a model in AI settings first.");
  if (s.provider !== "openai" && !s.apiKey) throw new AiError("Add your API key in AI settings first.");
  if (s.provider === "anthropic") {
    // The Anthropic SDK is a separate module, loaded only when it is used.
    const mod = await import(/* webpackIgnore: true */ new URL("assets/ai-anthropic.mjs", rootUrl).href) as
      { chat: (s: AiSettings, r: ChatRequest) => Promise<string> };
    return mod.chat(s, req);
  }
  if (s.provider === "gemini") return gemini(s, req);
  return openai(s, req);
}

/** Read a server-sent-events body, calling onData with each "data:" payload. */
async function readSse(res: Response, onData: (data: string) => void): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line.startsWith("data:")) onData(line.slice(5).trim());
    }
  }
}

async function failure(res: Response, provider: string): Promise<AiError> {
  let detail = "";
  try {
    const body = await res.json() as { error?: { message?: string } | string; message?: string };
    detail = typeof body.error === "string" ? body.error : body.error?.message || body.message || "";
  } catch { /* not JSON */ }
  if (res.status === 401 || res.status === 403) return new AiError(`${provider} rejected the API key${detail ? `: ${detail}` : "."}`);
  if (res.status === 429) return new AiError(`${provider} rate limit reached; try again in a moment.`);
  return new AiError(`${provider} error ${res.status}${detail ? `: ${detail}` : ""}`);
}

function jsonInstruction(schema: Record<string, unknown>): string {
  return "\n\nReply with only a JSON object (no prose, no code fences) matching this JSON schema:\n" + JSON.stringify(schema);
}

async function openai(s: AiSettings, req: ChatRequest): Promise<string> {
  const base = (s.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const send = (format: Record<string, unknown> | undefined, extraSystem: string) => fetch(`${base}/chat/completions`, {
    method: "POST",
    signal: req.signal,
    headers: { "Content-Type": "application/json", ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}) },
    body: JSON.stringify({
      model: s.model,
      stream: true,
      messages: [{ role: "system", content: req.system + extraSystem }, ...req.messages],
      ...(format ? { response_format: format } : {}),
    }),
  });
  let res: Response;
  try {
    res = await send(req.schema ? { type: "json_schema", json_schema: { name: "response", strict: true, schema: req.schema } } : undefined, "");
    // Servers without JSON-schema support: plain JSON mode, schema in the prompt.
    if (req.schema && res.status === 400) res = await send({ type: "json_object" }, jsonInstruction(req.schema));
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new AiError(`Could not reach ${base}. For a local server, allow this site's origin (e.g. OLLAMA_ORIGINS=*).`);
  }
  if (!res.ok) throw await failure(res, "The model server");
  let text = "";
  await readSse(res, (data) => {
    if (data === "[DONE]") return;
    try {
      const delta = (JSON.parse(data) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content;
      if (delta) { text += delta; req.onText?.(delta); }
    } catch { /* keep-alive or partial line */ }
  });
  return text;
}

async function gemini(s: AiSettings, req: ChatRequest): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(s.model)}:streamGenerateContent?alt=sse`;
  const res = await fetch(url, {
    method: "POST",
    signal: req.signal,
    headers: { "Content-Type": "application/json", "x-goog-api-key": s.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: req.system + (req.schema ? jsonInstruction(req.schema) : "") }] },
      contents: req.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      generationConfig: req.schema ? { responseMimeType: "application/json" } : {},
    }),
  });
  if (!res.ok) throw await failure(res, "Gemini");
  let text = "";
  await readSse(res, (data) => {
    try {
      const parts = (JSON.parse(data) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }).candidates?.[0]?.content?.parts;
      const delta = parts?.map((p) => p.text || "").join("") || "";
      if (delta) { text += delta; req.onText?.(delta); }
    } catch { /* partial line */ }
  });
  return text;
}

/** Parse a JSON answer, tolerating code fences and text around the object. */
export function parseJson<T>(text: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new AiError("The model did not return JSON. Try again or pick a stronger model.");
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch {
    throw new AiError("The model returned malformed JSON. Try again or pick a stronger model.");
  }
}
