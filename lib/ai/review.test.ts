import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  blockingIssues,
  buildReviewRequest,
  buildRevisionNote,
  crisisBackstop,
  fallbackReply,
  parseReview,
  type Review,
} from "./review.ts";

describe("parseReview", () => {
  test("accepts a valid review", () => {
    const r = parseReview(
      JSON.stringify({
        verdict: "revise",
        issues: [{ category: "unsupported_claim", severity: "critical", problem: "x" }],
      }),
    );
    assert.deepEqual(r, {
      verdict: "revise",
      issues: [{ category: "unsupported_claim", severity: "critical", problem: "x" }],
    });
  });

  test("rejects non-JSON, unknown verdicts, categories and severities", () => {
    assert.equal(parseReview("not json"), null);
    assert.equal(parseReview(JSON.stringify({ verdict: "ok", issues: [] })), null);
    assert.equal(parseReview(JSON.stringify({ verdict: "pass" })), null);
    assert.equal(
      parseReview(
        JSON.stringify({ verdict: "pass", issues: [{ category: "made_up", severity: "minor", problem: "" }] }),
      ),
      null,
    );
    assert.equal(
      parseReview(
        JSON.stringify({ verdict: "pass", issues: [{ category: "tone", severity: "high", problem: "" }] }),
      ),
      null,
    );
  });
});

describe("crisisBackstop", () => {
  test("flags a crisis message whose reply lacks 988", () => {
    const issue = crisisBackstop("I want to die", "Here is how Title IX works.");
    assert.equal(issue?.category, "crisis_missed");
    assert.equal(issue?.severity, "critical");
  });

  test("passes when the reply includes 988, or there is no crisis", () => {
    assert.equal(crisisBackstop("I want to die", "Please call or text 988 now."), null);
    assert.equal(crisisBackstop("What is Title IX?", "Title IX is..."), null);
  });
});

describe("blockingIssues", () => {
  const pass: Review = { verdict: "pass", issues: [] };

  test("a clean pass has no blocking issues", () => {
    assert.deepEqual(blockingIssues(pass, "What is Title IX?", "Title IX is..."), []);
  });

  test("minor issues alone don't block", () => {
    const r: Review = { verdict: "pass", issues: [{ category: "tone", severity: "minor", problem: "x" }] };
    assert.deepEqual(blockingIssues(r, "hi", "hello"), []);
  });

  test("critical issues block even if the verdict says pass", () => {
    const r: Review = {
      verdict: "pass",
      issues: [{ category: "unsupported_claim", severity: "critical", problem: "x" }],
    };
    assert.equal(blockingIssues(r, "hi", "hello").length, 1);
  });

  test("a revise verdict with only minor issues still blocks", () => {
    const r: Review = { verdict: "revise", issues: [{ category: "tone", severity: "minor", problem: "x" }] };
    assert.equal(blockingIssues(r, "hi", "hello").length, 1);
    assert.equal(blockingIssues({ verdict: "revise", issues: [] }, "hi", "hello").length, 1);
  });

  test("the crisis backstop blocks even when the reviewer passes", () => {
    const issues = blockingIssues(pass, "I want to kill myself", "Here is the Title IX process.");
    assert.deepEqual(issues.map((i) => i.category), ["crisis_missed"]);
  });

  test("the crisis issue isn't duplicated when the reviewer already caught it", () => {
    const r: Review = {
      verdict: "revise",
      issues: [{ category: "crisis_missed", severity: "critical", problem: "x" }],
    };
    assert.equal(blockingIssues(r, "I want to die", "Title IX...").length, 1);
  });
});

describe("prompts", () => {
  test("the review request wraps the conversation and draft", () => {
    const text = buildReviewRequest(
      [
        { role: "user", content: "Q1" },
        { role: "assistant", content: "A1" },
        { role: "user", content: "Q2" },
      ],
      "DRAFT",
    );
    assert.match(text, /<conversation>[\s\S]*<user>\nQ1\n<\/user>[\s\S]*<assistant>\nA1/);
    assert.match(text, /<draft_reply>\nDRAFT\n<\/draft_reply>/);
  });

  test("the revision note lists every problem and includes the draft", () => {
    const note = buildRevisionNote("DRAFT", [
      { category: "wrong_school", severity: "critical", problem: "P1" },
      { category: "crisis_missed", severity: "critical", problem: "P2" },
    ]);
    assert.match(note, /1\. \[wrong_school\] P1/);
    assert.match(note, /2\. \[crisis_missed\] P2/);
    assert.match(note, /DRAFT/);
  });
});

describe("fallbackReply", () => {
  test("leads with crisis resources when the message suggests crisis", () => {
    const reply = fallbackReply("I don't want to live anymore");
    assert.match(reply, /911/);
    assert.match(reply, /988/);
    assert.ok(reply.indexOf("988") < reply.indexOf("Title IX"));
  });

  test("otherwise points to human help without crisis lines", () => {
    const reply = fallbackReply("What is the deadline to file?");
    assert.doesNotMatch(reply, /988/);
    assert.match(reply, /RAINN/);
  });
});
