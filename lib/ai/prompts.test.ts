import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { parsePromptFile } from "./prompts.ts";

const sample = `<!-- header notes for people -->
<!-- SECTION: rules -->
Rule one.
<!-- a note the model shouldn't see -->
Rule two.
<!-- SECTION: never-do -->
Bad example.
<!-- SECTION: crisis-override -->
Crisis text.
<!-- SECTION: reviewer -->
Review carefully.
`;

describe("parsePromptFile", () => {
  test("splits sections and strips comments", () => {
    const p = parsePromptFile(sample);
    assert.equal(p.rules, "Rule one.\n\nRule two.");
    assert.equal(p["never-do"], "Bad example.");
    assert.equal(p["crisis-override"], "Crisis text.");
    assert.equal(p.reviewer, "Review carefully.");
    assert.doesNotMatch(JSON.stringify(p), /header notes|shouldn't see/);
  });

  test("names a missing section", () => {
    assert.throws(
      () => parsePromptFile(sample.replace("<!-- SECTION: reviewer -->", "")),
      /missing or has empty section\(s\): reviewer/,
    );
  });

  test("rejects an empty section", () => {
    assert.throws(
      () => parsePromptFile(sample.replace("Crisis text.", "<!-- todo -->")),
      /crisis-override/,
    );
  });

  test("rejects unknown and duplicate sections", () => {
    assert.throws(() => parsePromptFile(sample + "<!-- SECTION: extras -->\nx"), /Unknown section "extras"/);
    assert.throws(() => parsePromptFile(sample + "<!-- SECTION: rules -->\nx"), /appears twice/);
  });

  test("the real prompt file parses, and its help notes stay out of the prompts", () => {
    const text = readFileSync(new URL("../prompts/system.md", import.meta.url), "utf8");
    const p = parsePromptFile(text);
    assert.match(p.rules, /CRISIS FIRST/);
    assert.match(p["crisis-override"], /988/);
    assert.match(p.reviewer, /verdict/);
    assert.doesNotMatch(JSON.stringify(p), /How to edit/);
  });
});
