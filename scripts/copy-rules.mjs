// Copy rules shared by everything that writes text into nations.json — the
// per-team writer (generate-digests.mjs) and the "Around the world" roundup
// (world-roundup.mjs). Lives in its own module so the roundup can check copy
// without importing the generator, which imports the roundup.

export const words = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;

// Copy defects a cheaper model is prone to: leaked citation markup, and clock
// times/timezones in the copy (the app renders kickoff lines itself). Scores
// like "45-21" have no colon, so they pass.
export const BANNED_COPY = [
  [/<\/?cite/i, "citation markup"],
  [/\b\d{1,2}:\d{2}\b/, "clock time"],
  [/\b(AEST|AEDT|SAST|GMT|BST|UTC|CET|CEST)\b/, "timezone"],
];

// The rule that failed, or null when the copy is clean.
export function bannedCopyIn(text) {
  for (const [re, label] of BANNED_COPY) if (re.test(text)) return label;
  return null;
}
