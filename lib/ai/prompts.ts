// Splits lib/prompts/system.md (the editable rules-and-safeguards file) into its sections.
// The file marks each section with a line like `<!-- SECTION: rules -->`. Any other
// `<!-- ... -->` comment is a note for people and is removed before text reaches a model.

export const PROMPT_SECTIONS = ["rules", "never-do", "crisis-override", "reviewer"] as const;
export type PromptSection = (typeof PROMPT_SECTIONS)[number];
export type PromptFile = Record<PromptSection, string>;

const MARKER = /<!--\s*SECTION:\s*([\w-]+)\s*-->/g;

/** Parse the prompt file. Throws with a readable message if a section is missing or unknown. */
export function parsePromptFile(text: string): PromptFile {
  const markers = [...text.matchAll(MARKER)];
  const found = new Map<string, string>();
  markers.forEach((m, i) => {
    const name = m[1];
    if (!PROMPT_SECTIONS.includes(name as PromptSection)) {
      throw new Error(
        `Unknown section "${name}" in the prompt file. Valid sections: ${PROMPT_SECTIONS.join(", ")}.`,
      );
    }
    if (found.has(name)) throw new Error(`Section "${name}" appears twice in the prompt file.`);
    const start = m.index + m[0].length;
    const end = i + 1 < markers.length ? markers[i + 1].index : text.length;
    found.set(name, stripComments(text.slice(start, end)));
  });

  const missing = PROMPT_SECTIONS.filter((s) => !found.get(s));
  if (missing.length > 0) {
    throw new Error(
      `The prompt file is missing or has empty section(s): ${missing.join(", ")}. ` +
        `Each needs a line like <!-- SECTION: ${missing[0]} --> followed by its text.`,
    );
  }
  return Object.fromEntries(PROMPT_SECTIONS.map((s) => [s, found.get(s)!])) as PromptFile;
}

function stripComments(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
