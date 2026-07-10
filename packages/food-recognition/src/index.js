/**
 * @nutrilens/food-recognition
 *
 * In-browser (and Node) food recognition on ONNX Runtime:
 *  - {@link SwinFoodClassifier}: fine-tuned Food-101 closed-set head (92% top-1)
 *  - {@link ZeroShotFoodClassifier}: CLIP-style open-vocabulary head with
 *    precomputed text embeddings (extensible without retraining)
 *  - {@link FusionScorer} / {@link FoodRecognizer}: calibrated late fusion with
 *    non-food rejection
 *
 * @example
 * import * as ort from 'onnxruntime-web';
 * import { SwinFoodClassifier, ZeroShotFoodClassifier, FusionScorer, FoodRecognizer } from '@nutrilens/food-recognition';
 *
 * const swin = await SwinFoodClassifier.load(ort, '/models/swin-food101/onnx/model_int8.onnx', food101Labels);
 * const zs   = await ZeroShotFoodClassifier.load(ort, '/models/mobileclip-s0/onnx/vision_model_int8.onnx', embeddings);
 * const rec  = new FoodRecognizer(swin, zs, new FusionScorer(vocab));
 * const { top, isFood } = await rec.recognize(rawImage);
 */
export { SwinFoodClassifier, softmax } from './swin-classifier.js';
export { ZeroShotFoodClassifier } from './zero-shot.js';
export { FusionScorer, FoodRecognizer } from './fusion.js';
