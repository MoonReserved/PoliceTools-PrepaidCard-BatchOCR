'use strict';
// Review the model's immutable default result, never assign model scores to edits.
// Scores are CTC emission scores, not calibrated probabilities of correctness.
(() => {
  const DEFAULT_THRESHOLD = 0.80;
  // Optional overrides use the recognized character, e.g. {'I': 0.85, '1': 0.85}.
  const CHARACTER_THRESHOLDS = Object.freeze({});
  const validScore = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

  // Detection only: preserve the original character and its code-point position.
  // Include lowercase and full-width forms without rewriting the user's code.
  function findAmbiguousCharacters(text) {
    return Array.from(typeof text === 'string' ? text : '', (character, index) => ({position: index + 1, character}))
      .filter(({character}) => /^[O0I1]$/i.test(character.normalize('NFKC')));
  }

  function analyze(primary, options = {}) {
    const threshold = options.threshold ?? DEFAULT_THRESHOLD;
    const overrides = options.characterThresholds ?? CHARACTER_THRESHOLDS;
    if (!validScore(threshold) || !overrides || typeof overrides !== 'object' || Object.values(overrides).some(value => !validScore(value))) {
      throw new TypeError('單字門檻必須是 0 到 1 的數字。');
    }
    const best = primary?.best, text = typeof best?.text === 'string' ? best.text : '';
    const characters = Array.from(text), scores = best?.charConfidence;
    // Never shift scores onto the wrong character when data is missing or malformed.
    const aligned = Array.isArray(scores) && scores.length === characters.length;
    const letters = characters.map((character, index) => {
      const score = aligned && validScore(scores[index]) ? scores[index] : null;
      const limit = Object.prototype.hasOwnProperty.call(overrides, character) ? overrides[character] : threshold;
      return {position: index + 1, character, score, threshold: limit, low: score !== null && score < limit};
    });
    const lowCharacters = letters.filter(letter => letter.low);
    const ambiguousCharacters = findAmbiguousCharacters(text);
    const candidates = (primary?.candidates || []).filter(candidate => typeof candidate?.text === 'string');
    const differingCandidates = candidates.filter(candidate => candidate.text !== text);
    return {text, letters, lowCharacters, ambiguousCharacters, differingCandidates, candidateCount: candidates.length,
      hasDisagreement: differingCandidates.length > 0,
      needsReview: lowCharacters.length > 0 || differingCandidates.length > 0 || ambiguousCharacters.length > 0};
  }
  const api = Object.freeze({analyze, findAmbiguousCharacters, defaultThreshold: DEFAULT_THRESHOLD, characterThresholds: CHARACTER_THRESHOLDS});
  globalThis.OfflineOCRReview = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();
