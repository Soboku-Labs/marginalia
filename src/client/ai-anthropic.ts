// Claude through the official Anthropic SDK, called from the browser with the
// reader's own key (they type it into AI settings; it never leaves their
// browser except to go to Anthropic). Bundled as a separate module that
// providers.ts loads only when Anthropic is the chosen provider.
import Anthropic from "@anthropic-ai/sdk";
import { AiError, type AiSettings, type ChatRequest } from "./ai/providers";

// Models that accept server-side refusal fallbacks ("default" routing).
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export async function chat(s: AiSettings, req: ChatRequest): Promise<string> {
  const client = new Anthropic({
    apiKey: s.apiKey,
    // A key the reader supplies for their own use, in their own browser.
    dangerouslyAllowBrowser: true,
    ...(s.baseUrl ? { baseURL: s.baseUrl } : {}),
  });
  const maxTokens = req.maxTokens ?? 32000;
  const outputConfig = req.schema
    ? { output_config: { format: { type: "json_schema" as const, schema: req.schema } } }
    : {};
  try {
    let stopReason: string | null;
    let text: string;
    if (FALLBACK_MODELS.has(s.model)) {
      const stream = client.beta.messages.stream({
        model: s.model,
        max_tokens: maxTokens,
        system: req.system,
        messages: req.messages,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        ...outputConfig,
      }, { signal: req.signal });
      stream.on("text", (delta) => req.onText?.(delta));
      const message = await stream.finalMessage();
      stopReason = message.stop_reason;
      text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    } else {
      const stream = client.messages.stream({
        model: s.model,
        max_tokens: maxTokens,
        system: req.system,
        messages: req.messages,
        ...outputConfig,
      }, { signal: req.signal });
      stream.on("text", (delta) => req.onText?.(delta));
      const message = await stream.finalMessage();
      stopReason = message.stop_reason;
      text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    }
    if (stopReason === "refusal") throw new AiError("Claude declined this request.");
    if (stopReason === "max_tokens" && req.schema) throw new AiError("The answer was cut off; ask for fewer items.");
    return text;
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (e instanceof Anthropic.APIUserAbortError) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    if (e instanceof Anthropic.AuthenticationError) throw new AiError("Anthropic rejected the API key.");
    if (e instanceof Anthropic.PermissionDeniedError) throw new AiError("This API key cannot use that model.");
    if (e instanceof Anthropic.NotFoundError) throw new AiError(`Unknown model "${s.model}".`);
    if (e instanceof Anthropic.RateLimitError) throw new AiError("Anthropic rate limit reached; try again in a moment.");
    if (e instanceof Anthropic.BadRequestError) throw new AiError(`Anthropic rejected the request: ${e.message}`);
    if (e instanceof Anthropic.APIConnectionError) throw new AiError("Could not reach Anthropic. Check your connection.");
    if (e instanceof Anthropic.APIError) throw new AiError(`Anthropic error ${e.status ?? ""}: ${e.message}`);
    throw e;
  }
}
