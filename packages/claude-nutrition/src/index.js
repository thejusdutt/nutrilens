/**
 * @nutrilens/claude-nutrition
 *
 * A BUILD-TIME tool. Compute a dish's per-100 g nutrition with Claude, hold it to
 * nutrition-label arithmetic, and cross-verify it against a reference source
 * (USDA FNDDS) before trusting it. Its output is baked into the shipped
 * nutrition database, so the app itself stays fully offline and on-device.
 *
 * Nothing here runs in the browser and nothing here ships. NutriLens makes no
 * network call for nutrition: Claude's role is to harden the static database
 * ahead of time, not to answer at runtime. See docs/claude-nutrition.md.
 */
export { estimateNutrition, SYSTEM_PROMPT } from './estimate.js';
export {
  FIELD_MAP, ATWATER, atwaterKcal, parseNutrition, validatePer100g,
} from './schema.js';
export { crossVerify, blendPer100g, reconcileFat } from './cross-verify.js';
