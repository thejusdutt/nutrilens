/** Shared food-identity confidence rules for single- and multi-dish results. */
export const UNSURE_BELOW = 0.5;

export function confidenceLevel(probability) {
  const p = Number.isFinite(probability) ? probability : 0;
  if (p >= 0.75) return 'high';
  if (p >= UNSURE_BELOW) return 'medium';
  return 'low';
}

export const confidenceNeedsReview = (probability) => probability < UNSURE_BELOW;
