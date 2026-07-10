# @nutrilens/food-recognition

Food recognition for the browser (and Node) on ONNX Runtime, combining:

- **`SwinFoodClassifier`** — a closed-set head wrapping any image-classification
  ONNX model; NutriLens ships Swin-Base fine-tuned on Food-101
  (92.1% top-1, Apache-2.0, `onnx-community/swin-finetuned-food101-ONNX`).
- **`ZeroShotFoodClassifier`** — an open-vocabulary CLIP-style head. Ships the
  MobileCLIP-S0 *vision tower only* (11.8 MB int8); label text embeddings are
  precomputed at build time with prompt ensembling, so the vocabulary is
  extensible without retraining **or** shipping a text encoder/tokenizer.
- **`FusionScorer` / `FoodRecognizer`** — confidence-adaptive log-linear late
  fusion over the union label space, with non-food rejection via probe labels
  ("a person", "an empty plate", …).

Why fusion? Food-101 misses everyday foods (plain rice, biryani, dosa, raw
fruit…). The zero-shot head covers an arbitrary vocabulary at lower per-class
accuracy; fusion keeps the fine-tuned head's accuracy where it applies and
falls back gracefully where it doesn't — measurably better than either head
alone (see the NutriLens ACCURACY_REPORT).

## Usage

```js
import * as ort from 'onnxruntime-web';  // or onnxruntime-node
import {
  SwinFoodClassifier, ZeroShotFoodClassifier, FusionScorer, FoodRecognizer,
} from '@nutrilens/food-recognition';

const swin = await SwinFoodClassifier.load(ort, swinModelUrlOrBytes, food101Labels);
const zs = await ZeroShotFoodClassifier.load(ort, clipVisionModel, {
  labels, matrix /* Float32Array [n×dim], L2-normalized rows */, dim: 512, logitScale: 100,
});
const recognizer = new FoodRecognizer(swin, zs, new FusionScorer(vocab));

const { top, isFood, uncertain } = await recognizer.recognize(rawImage);
// top[0] → { id: 'biryani', name: 'Biryani', prob: 0.83, sources: {...} }
```

`vocab` is an array of `{ id, name, f101: number|null, nonFood?: boolean }`
**index-aligned with the embedding matrix rows**.

Fusion parameters (`wSwin`, `oovBias`, `probeMass`, `minConfidence`) are
constructor options; NutriLens fits them on a validation split (see
`eval/make-report.mjs`).

MIT license. Depends only on `@nutrilens/image-preprocess` + your ONNX runtime.
