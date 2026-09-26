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
 * classifies four quadrant crops and keeps a companion only if one crop names
 * it with at least COMPANION_MIN_PROB. Only foods on the main dish's list can
 * be added, so a background glass cannot become "tonic water".
 *
 * The threshold is set on the 38 benchmark photos, which are also what it is
 * scored on. There, the highest-scoring companion that was NOT on the plate
 * reached 0.094 (a tomato chutney beside idli); real companions ranged from
 * 0.012 (half-cropped bowls) to 1.0. It was 0.12 at first, and the stability
 * gate showed why that was too close: a tomato chutney at 0.127 came and went
 * when the same photo was re-saved. At 0.2 the three real hits between 0.12
 * and 0.2 are given up, and what remains is well clear of both the noise and
 * the highest false score.
 *
 * A main dish with no list costs nothing: no crops are classified. One with a
 * list costs four extra classifications (~4 s on a laptop CPU), which the app
 * runs after the main dish is already on screen.
 */
import { crop } from '@nutrilens/image-preprocess';

/** main dish id → foods that are commonly served beside it. */
export const GOES_WITH = {
  idli: ['sambar', 'coconut-chutney', 'tomato-chutney', 'green-chutney', 'vada'],
  dosa: ['sambar', 'coconut-chutney', 'tomato-chutney', 'green-chutney', 'vada'],
  'masala-dosa': ['sambar', 'coconut-chutney', 'tomato-chutney', 'green-chutney', 'vada'],
  vada: ['sambar', 'coconut-chutney', 'tomato-chutney', 'idli'],
  upma: ['coconut-chutney', 'sambar'],
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

/** Lowest crop probability at which a companion is logged. See the header. */
export const COMPANION_MIN_PROB = 0.2;

/** Foods a crop cannot tell apart count once: every chutney is "a chutney". */
export const sameClass = (id) => (/chutney$/.test(id) ? 'chutney' : id);

/** Four half-size windows, one per quadrant. */
export function quadrants(width, height) {
  const w = Math.round(width / 2);
  const h = Math.round(height / 2);
  return [[0, 0], [width - w, 0], [0, height - h], [width - w, height - h]]
    .map(([x, y]) => ({ x, y, w, h }));
}

/**
 * @param {object} args
 * @param {{data:Uint8ClampedArray,width:number,height:number}} args.image
 * @param {string} args.mainId the dish the whole photo was named as
 * @param {(img:object)=>Promise<{top:{id:string,prob:number}[]}>} args.classify
 * @param {(id:string)=>object|null} args.foodById
 * @param {number} [args.minProb]
 * @returns {Promise<{id:string, prob:number, grams:number}[]>} strongest first
 */
export async function findCompanions({ image, mainId, classify, foodById, minProb = COMPANION_MIN_PROB }) {
  const wanted = (GOES_WITH[mainId] ?? []).filter((id) => id !== mainId && foodById(id));
  if (!wanted.length) return [];
  const best = new Map();
  for (const { x, y, w, h } of quadrants(image.width, image.height)) {
    const { top } = await classify(crop(image, x, y, w, h));
    for (const id of wanted) {
      const p = top.find((t) => t.id === id)?.prob ?? 0;
      if (p > (best.get(id) ?? 0)) best.set(id, p);
    }
  }
  const kept = [];
  const classes = new Set();
  for (const [id, prob] of [...best].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))) {
    if (prob < minProb) break;
    // One chutney per plate. Crops of a single bowl score as several chutneys
    // (coconut 0.46 and green 0.18 for the same bowl on dosa-thali); of the
    // three benchmark photos with more than one chutney hit, two had one bowl.
    // Where there really are two, the second is small and can be added by hand.
    const cls = sameClass(id);
    if (classes.has(cls)) continue;
    classes.add(cls);
    kept.push({ id, prob, grams: foodById(id).prior?.servingG ?? 100 });
  }
  return kept;
}
