// Crisis detection for the chat route (Agent A, AI core).
// Defense-in-depth: the system prompt already makes crisis handling rule #1; when the
// latest user message matches these patterns the route appends a non-cached reinforcement
// system block (the "crisis-override" section of lib/prompts/system.md) so the safety
// behavior is anchored even if the model under-reacts.
// Kept in its own module so it is unit-testable in isolation.

export const CRISIS_PATTERNS: RegExp[] = [
  /\bkill(ing)? myself\b/i,
  /\bend (my life|it all|my life)\b/i,
  /\bsuicid/i,
  /\bself[-\s]?harm/i,
  /\bhurt(ing)? myself\b/i,
  /\bwant to die\b/i,
  /\bdon'?t want to (be alive|live)\b/i,
  /\bno reason to (live|go on)\b/i,
  /\bin (immediate |serious )?danger\b/i,
  /\b(he|she|they)('s| is| are)? going to (kill|hurt|attack)\b/i,
  /\bbeing (followed|stalked|threatened)\b/i,
  /\b(he|she|they)('s| is| are) (here|outside)( right)? now\b/i,
];

export function looksLikeCrisis(text: string): boolean {
  return CRISIS_PATTERNS.some((re) => re.test(text));
}
