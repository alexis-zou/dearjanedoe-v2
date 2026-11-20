import { readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { ChatRequest, Message, School } from "@/lib/types";
import { looksLikeCrisis } from "@/lib/crisis";
import { parsePromptFile } from "@/lib/ai/prompts";
import {
  REVIEW_SCHEMA,
  blockingIssues,
  buildReviewRequest,
  buildRevisionNote,
  fallbackReply,
  parseReview,
  type Review,
} from "@/lib/ai/review";

// Route handlers run on the Node.js runtime by default — we rely on that to read the
// corpus from the filesystem and to keep the Anthropic key server-side only
// (never NEXT_PUBLIC_, never sent to the browser). `cacheComponents` in next.config
// disallows an explicit `export const runtime`, so we don't set one.

// Requests go through Hopscotch AI (an API gateway), which serves the Anthropic
// Messages format at /v1/messages. Model ids there are "provider/model", and only some
// models are offered on /v1/messages (GET /v1/models lists `endpoint_families`).
const HOPSCOTCH_BASE_URL = "https://api.hopscotchlabs.ai";

// Two models: a stronger writer drafts each reply, and a cheaper reviewer checks it for
// facts and safety before it is sent (see lib/ai/review.ts).
const WRITER_MODEL = "anthropic/claude-opus-5";
const REVIEWER_MODEL = "anthropic/claude-sonnet-5";
// Room for adaptive thinking on top of the reply itself; replies stay short via the prompt.
const WRITER_MAX_TOKENS = 16000;
const REVIEWER_MAX_TOKENS = 8000;
// How many times the writer may fix a draft the reviewer rejected before we fall back.
const MAX_REVISIONS = 1;
const MAX_MESSAGES = 40;
const MAX_CHARS_PER_MESSAGE = 8000;

const VALID_SCHOOLS: School[] = ["cornell", "stanford", "berkeley"];

// ---- Build the byte-stable prompts from lib/prompts/system.md + the corpus ----
// Keep these exact strings identical across requests so prompt caching hits.
interface Prompts {
  /** Writer system prompt: rules + never-do examples + corpus. */
  writer: string;
  /** Reviewer system prompt: reviewer instructions + the writer's rules, examples and corpus. */
  reviewer: string;
  /** Appended (uncached) when the latest user message looks like a crisis. */
  crisisOverride: string;
}

function loadPrompts(): Prompts {
  const root = process.cwd();
  // Literal paths so the bundler statically traces exactly these files
  // (a variable path would cause it to trace/bundle the whole project).
  const file = parsePromptFile(readFileSync(join(root, "lib/prompts/system.md"), "utf8"));
  const federal = readFileSync(join(root, "content/corpus/title-ix-federal.md"), "utf8");
  const cornell = readFileSync(join(root, "content/corpus/cornell.md"), "utf8");
  const stanford = readFileSync(join(root, "content/corpus/stanford.md"), "utf8");
  const berkeley = readFileSync(join(root, "content/corpus/berkeley.md"), "utf8");

  const writer = [
    file.rules,
    "\n\n",
    file["never-do"],
    "\n\n===== GROUNDING CORPUS (answer only from this) =====\n",
    "## FEDERAL BASELINE\n",
    federal,
    "\n\n## SCHOOL: CORNELL\n",
    cornell,
    "\n\n## SCHOOL: STANFORD\n",
    stanford,
    "\n\n## SCHOOL: BERKELEY\n",
    berkeley,
  ].join("\n");

  return {
    writer,
    reviewer: `${file.reviewer}\n\n===== RULES, NEVER-DO EXAMPLES AND CORPUS THE ASSISTANT WAS GIVEN =====\n\n${writer}`,
    crisisOverride: file["crisis-override"],
  };
}

// Production loads the prompts once. In development they're re-read on every request so
// edits to lib/prompts/system.md apply on the next message without a restart.
const LOADED_PROMPTS = process.env.NODE_ENV === "development" ? null : loadPrompts();

// Crisis detection lives in lib/crisis.ts (unit-tested). When the latest user message
// matches, we append a non-cached reinforcement system block — keeping the cached prefix
// byte-stable by NOT editing it.

// Replies can quote personal details, so nothing along the way may keep a copy.
const NO_STORE = { "Cache-Control": "no-store" };

function badRequest(error: string) {
  return Response.json({ error }, { status: 400, headers: NO_STORE });
}

export async function POST(req: Request) {
  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return badRequest("Invalid JSON body.");
  }

  const { messages, school } = body ?? {};

  // ---- Validate input ----
  if (!Array.isArray(messages) || messages.length === 0) {
    return badRequest("`messages` must be a non-empty array.");
  }
  if (messages.length > MAX_MESSAGES) {
    return badRequest("Too many messages in one request.");
  }
  const clean: Message[] = [];
  for (const m of messages) {
    if (
      !m ||
      (m.role !== "user" && m.role !== "assistant") ||
      typeof m.content !== "string"
    ) {
      return badRequest("Each message needs role 'user'|'assistant' and string content.");
    }
    const content = m.content.slice(0, MAX_CHARS_PER_MESSAGE).trim();
    if (content) clean.push({ role: m.role, content });
  }
  if (clean.length === 0 || clean[clean.length - 1].role !== "user") {
    return badRequest("The last message must be from the user.");
  }
  if (school !== undefined && !VALID_SCHOOLS.includes(school)) {
    return badRequest("Unknown school.");
  }

  let prompts: Prompts;
  try {
    prompts = LOADED_PROMPTS ?? loadPrompts();
  } catch (err) {
    // Usually a damaged SECTION marker in lib/prompts/system.md; the message says which.
    console.error(`[/api/chat] couldn't load prompts: ${(err as Error).message}`);
    return Response.json(
      { error: "Server is not configured. Please try again later." },
      { status: 500, headers: NO_STORE },
    );
  }

  const apiKey = process.env.HOPSCOTCH_API_KEY;
  if (!apiKey) {
    // Never echo the key or its absence beyond a generic message.
    return Response.json(
      { error: "Server is not configured. Please try again later." },
      { status: 500, headers: NO_STORE },
    );
  }

  // ---- Tell the model which school via the user turn (keeps the cached prefix stable) ----
  const outgoing = clean.map((m) => ({ ...m }));
  const last = outgoing[outgoing.length - 1];
  const schoolName =
    school === "cornell" ? "Cornell" : school === "stanford" ? "Stanford" : school === "berkeley" ? "Berkeley" : null;
  if (schoolName) {
    last.content = `${last.content}\n\n[School context: ${schoolName}]`;
  }

  // ---- System blocks: cached grounding prefix (+ optional non-cached crisis block) ----
  const systemBlocks: Anthropic.Beta.BetaTextBlockParam[] = [
    {
      type: "text",
      text: prompts.writer,
      // Default 5-minute cache: Hopscotch refuses the 1-hour cache write.
      cache_control: { type: "ephemeral" },
    },
  ];
  if (looksLikeCrisis(last.content)) {
    systemBlocks.push({ type: "text", text: prompts.crisisOverride });
  }

  // Hopscotch wants the key as a Bearer token, so pass it as authToken, not apiKey.
  const anthropic = new Anthropic({ apiKey: null, authToken: apiKey, baseURL: HOPSCOTCH_BASE_URL });
  const lastUserMessage = last.content;

  try {
    let draft = await writeReply(anthropic, systemBlocks, outgoing);
    for (let revisions = 0; draft !== null; revisions++) {
      const review = await reviewReply(anthropic, prompts.reviewer, outgoing, draft);
      // Fail closed: a reply that couldn't be reviewed is not sent.
      if (!review) break;

      const blocking = blockingIssues(review, lastUserMessage, draft);
      // Categories only (no content), so we can watch what the reviewer catches.
      console.log(
        `[/api/chat] review attempt=${revisions + 1} verdict=${review.verdict} ` +
          `blocking=${blocking.map((i) => i.category).join(",") || "none"} ` +
          `minor=${review.issues.filter((i) => i.severity === "minor").length}`,
      );
      if (blocking.length === 0) {
        return Response.json({ reply: draft }, { headers: NO_STORE });
      }
      if (revisions >= MAX_REVISIONS) break;

      // Ask the writer to fix it. The note is a mid-conversation system message after the
      // last user turn, so the cached system prefix stays byte-identical.
      draft = await writeReply(anthropic, systemBlocks, [
        ...outgoing,
        { role: "system", content: buildRevisionNote(draft, blocking) },
      ]);
    }

    console.warn("[/api/chat] no reply passed review; sending fallback");
    return Response.json({ reply: fallbackReply(lastUserMessage) }, { headers: NO_STORE });
  } catch (err) {
    // Name and status only: the full error can include the request, and so the messages.
    const { name, status } = (err ?? {}) as { name?: string; status?: number };
    console.error(`[/api/chat] Anthropic error: name=${name} status=${status}`);
    return Response.json(
      { error: "Sorry — something went wrong generating a response. Please try again." },
      { status: 502, headers: NO_STORE },
    );
  }
}

type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

// Token counts only (no message content) — lets us watch spend + cache hit rate.
function logUsage(step: string, u: Usage) {
  console.log(
    `[/api/chat] ${step} usage in=${u.input_tokens} out=${u.output_tokens} ` +
      `cacheRead=${u.cache_read_input_tokens ?? 0} cacheWrite=${u.cache_creation_input_tokens ?? 0}`,
  );
}

/** Draft a reply with the writer model. Returns null if it declined or was cut off. */
async function writeReply(
  anthropic: Anthropic,
  system: Anthropic.Beta.BetaTextBlockParam[],
  messages: Anthropic.Beta.BetaMessageParam[],
): Promise<string | null> {
  const resp = await anthropic.beta.messages.create({
    model: WRITER_MODEL,
    max_tokens: WRITER_MAX_TOKENS,
    output_config: { effort: "medium" },
    // If a safety classifier declines, the API retries on a fallback model in the same call.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    messages,
  });
  logUsage("write", resp.usage);
  if (resp.stop_reason !== "end_turn") {
    console.warn(`[/api/chat] writer stopped: ${resp.stop_reason}`);
    return null;
  }
  const text = resp.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return text || null;
}

/** Check a draft with the reviewer model. Returns null if review couldn't be completed. */
async function reviewReply(
  anthropic: Anthropic,
  system: string,
  conversation: { role: "user" | "assistant"; content: string }[],
  draft: string,
): Promise<Review | null> {
  try {
    const resp = await anthropic.messages.create({
      model: REVIEWER_MODEL,
      max_tokens: REVIEWER_MAX_TOKENS,
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: REVIEW_SCHEMA },
      },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: buildReviewRequest(conversation, draft) }],
    });
    logUsage("review", resp.usage);
    if (resp.stop_reason !== "end_turn") {
      console.warn(`[/api/chat] reviewer stopped: ${resp.stop_reason}`);
      return null;
    }
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const review = parseReview(text);
    if (!review) console.warn("[/api/chat] reviewer returned an unreadable review");
    return review;
  } catch (err) {
    const { name, status } = (err ?? {}) as { name?: string; status?: number };
    console.error(`[/api/chat] reviewer error: name=${name} status=${status}`);
    return null;
  }
}
