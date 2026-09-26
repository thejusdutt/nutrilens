/**
 * Side dishes that come with the main dish: sambar with idli, fries with a
 * burger, rice with rajma.
 *
 * The one-dish default names the plate from the whole photo, and on the whole
 * photo a side dish barely registers — fries next to a burger score 0.2% —
 * so it was never logged. Splitting the plate finds sides but also invents
 * food (16 phantom dishes on the benchmark), because any segment can be named
 * anything.
 *
 * This asks a narrower question. For a main dish with known companions it
 * classifies the four quadrants of the photo and keeps a companion only if a
 * quadrant names it with at least COMPANION_MIN_PROB. Only foods on the main
 * dish's list can be added, so a background glass cannot become "tonic water".
 *
 * Why quadrants and not smaller tiles. The eight outer tiles of a 3×3 grid
 * find more (22 real sides of 31 against 14, on the 39 benchmark photos), but
 * a small tile's score moves when the file is re-saved: six photos changed
 * their sides between re-encodings, and on one (idli with a bowl of sambar)
 * three of five re-encodings logged a tomato chutney that is not there — the
 * sambar bowl alone in its tile scored 0.20–0.23 as chutney. So the tiles are a
 * second pass (findMissedCompanions) that only adds what the quadrants did not
 * find, at a stricter 0.25: replayed over 39 photos × 5 re-encodings that is
 * 8 more real sides and none that were not there. It exists for bowls cut in
 * half by the quadrant lines (the user's coconut chutney: 0.047 in a quadrant,
 * 0.28 in a tile).
 *
 * The threshold is set on those same photos. The highest-scoring side that was
 * NOT on the plate reached 0.094. A first cut-off of 0.12 was raised to 0.2
 * after the stability gate showed a chutney at 0.127 coming and going when one
 * photo was re-saved.
 *
 * A main dish with no list costs nothing. One with a list costs four
 * classifications, which the app runs after the main dish is on screen.
 */
import { crop } from '@nutrilens/image-preprocess';

/**
 * Chutneys by colour. Bowls of one colour look alike on a photo (tomato,
 * onion and peanut are all orange), so a plate logs at most one chutney per
 * colour, and one bowl cannot be logged as both white and orange.
 */
export const CHUTNEY_COLOUR = {
  'coconut-chutney': 'white',
  'tomato-chutney': 'orange',
  'peanut-chutney': 'orange',
  'onion-chutney': 'orange',
  'green-chutney': 'green',
  chutney: 'brown', // sweet tamarind / date
};
const CHUTNEYS = ['coconut-chutney', 'tomato-chutney', 'peanut-chutney', 'onion-chutney', 'green-chutney'];

/** main dish id → foods that are commonly served beside it. */
export const GOES_WITH = {
  idli: ['sambar', ...CHUTNEYS, 'vada'],
  dosa: ['sambar', ...CHUTNEYS, 'vada'],
  'masala-dosa': ['sambar', ...CHUTNEYS, 'vada'],
  vada: ['sambar', ...CHUTNEYS, 'idli'],
  upma: ['sambar', ...CHUTNEYS],
  hamburger: ['french-fries', 'onion-rings'],
  omelette: ['french-fries', 'green-salad'],
  rajma: ['plain-rice', 'chapati'],
  dal: ['plain-rice', 'chapati'],
  'chana-masala': ['plain-rice', 'poori', 'chapati'],
  'chicken-curry': ['plain-rice', 'naan', 'chapati'],
  paratha: ['yogurt-plain'],
  poha: ['jalebi'],
  samosa: ['green-chutney', 'chutney'],
  dumplings: ['chutney'],
  pancakes: ['blueberries'],
  'kung-pao-chicken': ['plain-rice'],
  'general-tso-chicken': ['plain-rice'],
  'sweet-and-sour-pork': ['plain-rice'],
};

/** Lowest quadrant probability at which a companion is logged. See the header. */
export const COMPANION_MIN_PROB = 0.2;

/** Four half-size windows, one per quadrant. */
export function quadrants(width, height) {
  const w = Math.round(width / 2);
  const h = Math.round(height / 2);
  return [[0, 0], [width - w, 0], [0, height - h], [width - w, height - h]]
    .map(([x, y]) => ({ x, y, w, h }));
}

/**
 * Lowest probability for a side found only by the second, smaller-tile pass.
 * Stricter than the quadrant cut-off: a small tile's score moves more when the
 * file is re-saved, and at 0.2 one tile read a sambar bowl as tomato chutney
 * (0.20–0.23). Replayed over all 39 photos × 5 re-encodings at 0.25: 8 more
 * real sides, no side that was not on the plate.
 */
export const TILE_MIN_PROB = 0.25;

/** The eight outer tiles of a 3×3 grid, row by row. */
export function edgeTiles(width, height) {
  const w = Math.round(width / 3);
  const h = Math.round(height / 3);
  const tiles = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      if (row === 1 && col === 1) continue; // the centre is the main dish
      tiles.push({ x: Math.min(col * w, width - w), y: Math.min(row * h, height - h), w, h });
    }
  }
  return tiles;
}

const wantedFor = (mainId, foodById) => (GOES_WITH[mainId] ?? []).filter((id) => id !== mainId && foodById(id));
const withGrams = (found, foodById) => found
  .sort((a, b) => b.prob - a.prob || a.id.localeCompare(b.id))
  .map(({ id, prob }) => ({ id, prob, grams: foodById(id).prior?.servingG ?? 100 }));

/**
 * First pass: the four quadrants.
 * @param {object} args
 * @param {{data:Uint8ClampedArray,width:number,height:number}} args.image
 * @param {string} args.mainId the dish the whole photo was named as
 * @param {(img:object)=>Promise<{top:{id:string,prob:number}[]}>} args.classify
 * @param {(id:string)=>object|null} args.foodById
 * @param {number} [args.minProb]
 * @returns {Promise<{id:string, prob:number, grams:number}[]>} strongest first
 */
export async function findCompanions({ image, mainId, classify, foodById, minProb = COMPANION_MIN_PROB }) {
  const wanted = wantedFor(mainId, foodById);
  if (!wanted.length) return [];
  const { best, byColour } = await scan(image, quadrants(image.width, image.height), wanted, classify, minProb);
  return withGrams([
    ...[...best].filter(([, prob]) => prob >= minProb).map(([id, prob]) => ({ id, prob })),
    ...byColour.values(),
  ], foodById);
}

/**
 * Second pass: the eight outer tiles of a 3×3 grid, for what the quadrants
 * cut in half — a bowl on a quadrant's centre line is mostly outside every
 * quadrant (the user's coconut chutney scored 0.047 there and 0.28 in a
 * tile). Adds only sides not already found and chutney colours not already on
 * the plate, at the stricter TILE_MIN_PROB. The app runs it after showing the
 * first pass, so the first answer is no slower.
 * @param {object} args  as findCompanions, plus
 * @param {{id:string}[]} args.found what the first pass logged
 * @returns {Promise<{id:string, prob:number, grams:number}[]>} additions only
 */
export async function findMissedCompanions({ image, mainId, found, classify, foodById, minProb = TILE_MIN_PROB }) {
  const have = new Set(found.map((f) => f.id));
  const haveColours = new Set(found.map((f) => CHUTNEY_COLOUR[f.id]).filter(Boolean));
  const wanted = wantedFor(mainId, foodById).filter((id) => !have.has(id) && !haveColours.has(CHUTNEY_COLOUR[id]));
  if (!wanted.length) return [];
  const { best, byColour } = await scan(image, edgeTiles(image.width, image.height), wanted, classify, minProb);
  return withGrams([
    ...[...best].filter(([, prob]) => prob >= minProb).map(([id, prob]) => ({ id, prob })),
    ...byColour.values(),
  ], foodById);
}

/** Classify each window; best score per side, and one chutney vote per window. */
async function scan(image, windows, wanted, classify, minProb) {
  const sides = wanted.filter((id) => !CHUTNEY_COLOUR[id]);
  const chutneys = wanted.filter((id) => CHUTNEY_COLOUR[id]);
  const best = new Map(); // side id → best window probability
  const byColour = new Map(); // colour → { id, prob } of the strongest window vote
  for (const { x, y, w, h } of windows) {
    const { top } = await classify(crop(image, x, y, w, h));
    const p = (id) => top.find((t) => t.id === id)?.prob ?? 0;
    for (const id of sides) best.set(id, Math.max(best.get(id) ?? 0, p(id)));
    // Each quadrant votes for its own strongest chutney only, so one bowl read
    // as coconut 0.25 and peanut 0.22 in the same crop is one white bowl.
    // Adding up the chutneys of one colour instead was tried and rejected: it
    // kept an orange bowl whose score was split between orange names, but it
    // also turned a white coconut bowl orange (idli-vada-thali logged tomato
    // chutney instead of coconut), which is a wrong dish, not a missed one.
    let vote = null;
    for (const id of chutneys) if (p(id) > (vote?.prob ?? 0)) vote = { id, prob: p(id) };
    if (vote && vote.prob >= minProb) {
      const colour = CHUTNEY_COLOUR[vote.id];
      if (vote.prob > (byColour.get(colour)?.prob ?? 0)) byColour.set(colour, vote);
    }
  }
  return { best, byColour };
}
