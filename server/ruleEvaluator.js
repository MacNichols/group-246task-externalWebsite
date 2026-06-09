/**
 * Rule Evaluator Module
 *
 * The secret rule is defined here, server-side only.
 * Participants never see this file.
 *
 * To change the rule for a different condition, modify ONLY the
 * conformsToRule() function. Everything else stays the same.
 */

// ─── THE RULE ────────────────────────────────────────────────────────────────
// Change this function to implement any rule you want.
// It receives three numbers (a, b, c) and returns true or false.

function conformsToRule(a, b, c) {
  // Default: any strictly ascending sequence
  return b > a && c > b;
}

// ─── RULE LABEL (for researcher logs only, never shown to participants) ───────
const RULE_LABEL = "any strictly ascending sequence";

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Evaluate a proposed triple.
 * @param {string|number} a
 * @param {string|number} b
 * @param {string|number} c
 * @returns {{ valid: boolean, conforms: boolean|null, verdict: string, nums: number[]|null }}
 */
function evaluate(a, b, c) {
  const nums = [a, b, c].map(Number);

  if (nums.some(isNaN)) {
    return {
      valid: false,
      conforms: null,
      verdict: "Invalid — please enter three numbers.",
      nums: null,
    };
  }

  const conforms = conformsToRule(nums[0], nums[1], nums[2]);

  return {
    valid: true,
    conforms,
    verdict: conforms ? "Yes" : "No",
    nums,
  };
}

/**
 * Loosely assess whether a stated rule is correct.
 * This flags it for researcher review rather than making a definitive call —
 * natural language rule statements are hard to evaluate programmatically.
 * @param {string} statedRule
 * @returns {{ flagged: boolean, note: string }}
 */
function assessStatedRule(statedRule) {
  const lower = statedRule.toLowerCase();
  const ascendingKeywords = ["ascending", "increasing", "bigger", "larger", "greater", "goes up"];
  const matched = ascendingKeywords.some((kw) => lower.includes(kw));
  return {
    flagged: !matched,
    note: matched
      ? "Likely correct — contains ascending/increasing language."
      : "Flagged for researcher review — may not match rule.",
  };
}

module.exports = { evaluate, assessStatedRule, RULE_LABEL };
