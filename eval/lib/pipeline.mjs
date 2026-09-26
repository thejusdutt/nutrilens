/**
 * The photo pipeline, exactly as the app runs it, in one place.
 *
 * Extracted so every harness scores the same code. vision-bench measures how
 * close the answer is to a human reading; stability measures whether the answer
 * holds still when the file changes but the photograph does not. If they each
 * carried their own copy they would drift, and the drift would look like a
 * result.
 */
import * as ort from 'onnxruntime-node';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SlimSamSegmenter } from '@nutrilens/food-segmentation';
import {
  PortionEstimator, detectPlateEllipse,
} from '@nutrilens/portion-estimator';
import { NutritionEngine } from '@nutrilens/nutrition-engine';
import { proposeRegions, buildPlate, findCompanions } from '@nutrilens/plate-analyzer';
import { createRecognizer, root } from './node-runtime.mjs';

/**
 * Load models once and return an `analyse(image, opts)` bound to them.
 * @param {object} [recognizerOpts] forwarded to createRecognizer
 */
export async function createPipeline(recognizerOpts = {}, estimatorOpts = {}) {
  const models = join(root, 'app/public/models');
  const db = JSON.parse(readFileSync(join(root, 'app/public/data/nutrition-db.json'), 'utf8'));
  const engine = new NutritionEngine(db);
  const { recognizer } = await createRecognizer(recognizerOpts);
  const segmenter = await SlimSamSegmenter.load(
    ort,
    join(models, 'slimsam/onnx/vision_encoder_quantized.onnx'),
    join(models, 'slimsam/onnx/prompt_encoder_mask_decoder_quantized.onnx'),
  );
  const estimator = new PortionEstimator(estimatorOpts);

  /**
   * @param {{data:Uint8ClampedArray,width:number,height:number}} image
   * @param {object} [options] plate-analyzer overrides
   * @param {{split?:boolean}} [mode] `split` scores the opt-in breakdown
   */
  async function analyse(image, options = {}, { split = false, companions = true } = {}) {
    const whole = await recognizer.recognize(image, { whole: true });
    const imageTop = whole.top.filter((t) => engine.food(t.id));

    if (!split) {
      // The shipped default: one dish, named from the whole frame, weighed at
      // the food's typical serving.
      //
      // No segmentation at all. Scaling the portion by how much of the plate
      // the mask covers was measured to carry more noise than information: the
      // dominant mask swings up to 6.5x across re-encodings of the identical
      // photograph, and the plate ellipse it is measured against moves with it.
      // Sweeping the bound on that scaling over the whole benchmark:
      //
      //   maxFactor   in band   mean err   mean spread   worst spread
      //   2.5 (was)     13/20      15.8%          8.1%          53.8%
      //   1.4           15/20      13.3%          7.2%          41.4%
      //   1.0 (none)    14/20      13.7%          2.1%          22.0%
      //
      // Four times steadier for one photo of accuracy, which is noise at n=20.
      // Skipping the segmentation it no longer needs also takes the ~8 SAM
      // prompts out of the default path. The split path still uses area, where
      // it compares dishes within one frame and is worth its cost.
      const items = [];
      if (imageTop.length) {
        const food = engine.food(imageTop[0].id);
        const est = estimator.estimate({
          areaPx: 0, imageWidth: image.width, imageHeight: image.height, prior: food.prior,
        });
        items.push({
          id: imageTop[0].id, prob: imageTop[0].prob, grams: est.grams,
          portion: est, singleDish: true, region: null,
        });
        // Side dishes on the main dish's list, found in quadrant crops.
        if (companions) {
          const found = await findCompanions({
            image, mainId: imageTop[0].id,
            classify: (img) => recognizer.recognize(img),
            foodById: (id) => engine.food(id),
          });
          for (const c of found) {
            const portion = estimator.estimate({
              areaPx: 0, imageWidth: image.width, imageHeight: image.height, prior: engine.food(c.id).prior,
            });
            items.push({ ...c, grams: portion.grams, portion, companion: true, region: null });
          }
        }
      }
      return { whole, plate: null, regions: [], items, engine };
    }

    const plate = detectPlateEllipse(image);
    await segmenter.setImage(image);
    const { regions, dominant } = await proposeRegions({
      segment: (points) => segmenter.segment(points),
      width: image.width,
      height: image.height,
      plate,
      options,
    });

    const items = await buildPlate({
      image,
      regions,
      dominant,
      imageTop,
      plate,
      classify: (img) => recognizer.recognize(img),
      foodById: (id) => engine.food(id),
      estimator,
      options,
    });
    return { whole, plate, regions, items, engine };
  }

  return { analyse, engine, recognizer, segmenter, estimator };
}
