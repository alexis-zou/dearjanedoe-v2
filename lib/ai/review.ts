// Second-opinion review of every chat reply before it reaches the user.
//
// A stronger model writes the reply; a cheaper model checks the draft against the same
// grounding corpus and rules (facts, crisis handling, the rules in system.md). If the
// reviewer finds a serious problem, the writer gets one chance to fix it. If the fix still
// fails, or review itself can't run, the user gets a safe fallback reply instead of an
// unchecked one.
//
// The reviewer's instructions live in the "reviewer" section of lib/prompts/system.md.
// Kept free of SDK runtime imports so it can be unit-tested with `node --test`.

import { looksLikeCrisis } from "../crisis.ts";
import type { Message } from "../types.ts";

export const ISSUE_CATEGORIES = [
  "crisis_missed", // signs of crisis/danger, but the reply doesn't lead with crisis resources
  "unsupported_claim", // a policy, deadline, office, phone number or link not in the corpus
  "contradicts_corpus", // states something the corpus says differently
  "wrong_school", // uses another school's policy, or invents policy for an uncovered school
  "unverified_as_fact", // asserts VERIFY-BEFORE-DEMO specifics as settled fact
  "advises_on_reporting", // tells the person whether to report / press charges
  "doubts_account", // questions or tests what the person says happened
  "privacy", // asks for identifying details, or mishandles a {{vault.*}} placeholder
  "legal_advice", // case-specific prediction or strategy, or no general-information framing
  "tone", // cold, pressuring, judgmental, or graphic restatement
  "rule_violation", // breaks another rule or matches a never-do example in the prompt file
  "other",
] as const;
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];

export interface ReviewIssue {
  category: IssueCategory;
  /** critical = must not reach the user; minor = worth noting, can ship. */
  severity: "critical" | "minor";
  /** What is wrong and how to fix it. */
  problem: string;
}

export interface Review {
  verdict: "pass" | "revise";
  issues: ReviewIssue[];
}

/** JSON schema for the reviewer's structured output (output_config.format). */
export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "revise"] },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string", enum: [...ISSUE_CATEGORIES] },
          severity: { type: "string", enum: ["critical", "minor"] },
          problem: { type: "string" },
        },
        required: ["category", "severity", "problem"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict", "issues"],
  additionalProperties: false,
} as const;

/** Build the reviewer's user message: the conversation so far plus the draft. */
export function buildReviewRequest(conversation: Message[], draft: string): string {
  const turns = conversation
    .map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`)
    .join("\n");
  return (
    `<conversation>\n${turns}\n</conversation>\n\n` +
    `<draft_reply>\n${draft}\n</draft_reply>\n\n` +
    `Review the draft reply to the user's last message.`
  );
}

/** Parse the reviewer's JSON. Returns null if it isn't a valid review. */
export function parseReview(text: string): Review | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const { verdict, issues } = raw as Record<string, unknown>;
  if (verdict !== "pass" && verdict !== "revise") return null;
  if (!Array.isArray(issues)) return null;
  const clean: ReviewIssue[] = [];
  for (const i of issues) {
    if (!i || typeof i !== "object") return null;
    const { category, severity, problem } = i as Record<string, unknown>;
    if (!ISSUE_CATEGORIES.includes(category as IssueCategory)) return null;
    if (severity !== "critical" && severity !== "minor") return null;
    if (typeof problem !== "string") return null;
    clean.push({ category: category as IssueCategory, severity, problem });
  }
  return { verdict, issues: clean };
}

/**
 * Deterministic backstop that doesn't depend on either model: if the latest user message
 * matches the crisis patterns, the reply must include the 988 line.
 */
export function crisisBackstop(lastUserMessage: string, reply: string): ReviewIssue | null {
  if (!looksLikeCrisis(lastUserMessage)) return null;
  if (/\b988\b/.test(reply)) return null;
  return {
    category: "crisis_missed",
    severity: "critical",
    problem:
      "The user's message shows signs of crisis or danger, but the reply doesn't give the " +
      "crisis resources. Lead with care and: call 911 if in immediate danger; call or text " +
      "988; text HOME to 741741; RAINN 800-656-4673.",
  };
}

/** Issues that block a reply: the reviewer's critical issues plus the crisis backstop. */
export function blockingIssues(
  review: Review,
  lastUserMessage: string,
  reply: string,
): ReviewIssue[] {
  const blocking = review.issues.filter((i) => i.severity === "critical");
  // A "revise" verdict with only minor issues is inconsistent; treat it as blocking so a
  // reviewer that mislabels severity still gets the reply fixed.
  if (review.verdict === "revise" && blocking.length === 0) {
    blocking.push(...review.issues);
    if (blocking.length === 0) {
      blocking.push({
        category: "other",
        severity: "critical",
        problem: "The reviewer asked for a revision without naming an issue.",
      });
    }
  }
  const crisis = crisisBackstop(lastUserMessage, reply);
  if (crisis && !blocking.some((i) => i.category === "crisis_missed")) blocking.push(crisis);
  return blocking;
}

/** Operator note asking the writer to fix its draft. Sent as a mid-conversation system message. */
export function buildRevisionNote(draft: string, issues: ReviewIssue[]): string {
  const list = issues.map((i, n) => `${n + 1}. [${i.category}] ${i.problem}`).join("\n");
  return (
    `A safety and accuracy review found problems in your draft reply to the user's last ` +
    `message. Write a corrected reply that fixes every problem below. Follow all your ` +
    `rules, use only the grounding corpus, and keep everything in the draft that was fine. ` +
    `Reply with only the new message for the user; don't mention the draft or the review.\n\n` +
    `<draft_reply>\n${draft}\n</draft_reply>\n\n<problems>\n${list}\n</problems>`
  );
}

/** Sent when no reply passes review. Never includes model output. */
export function fallbackReply(lastUserMessage: string): string {
  const crisis = looksLikeCrisis(lastUserMessage);
  const lead = crisis
    ? "I'm really glad you reached out, and I want to make sure you can talk to a real person right now.\n\n" +
      "- If you are in immediate danger, call **911**.\n" +
      "- **988 Suicide & Crisis Lifeline**: call or text **988**.\n" +
      "- **Crisis Text Line**: text **HOME** to **741741**.\n" +
      "- **RAINN National Sexual Assault Hotline**: **800-656-4673**, 24/7.\n\n"
    : "I'm sorry, I couldn't put together an answer I'm confident is accurate, and I'd " +
      "rather not guess about something this important.\n\n";
  return (
    lead +
    "For questions about your rights and options, these people can help:\n\n" +
    "- **RAINN** (800-656-4673, 24/7) can connect you with a local advocate.\n" +
    "- A **confidential advocate** at your school can talk through options without filing anything.\n" +
    "- Your school's **Title IX office** can explain its process.\n\n" +
    "You're welcome to try asking again, maybe in different words."
  );
}
