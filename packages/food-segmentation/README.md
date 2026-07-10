# @nutrilens/food-segmentation

Promptable segmentation for the browser via **SlimSAM-77** (a 1.4%-size
distillation of Segment Anything; MIT) on ONNX Runtime, plus dependency-free
mask post-processing utilities.

The encoder runs **once per image** (`setImage`); every subsequent point prompt
(`segment`) is a ~90 ms decoder call, so interactive "tap the dish" flows are
cheap. Models: `Xenova/slimsam-77-uniform` quantized ONNX (12.2 MB encoder +
4.9 MB decoder).

## Usage

```js
import * as ort from 'onnxruntime-web';
import { SlimSamSegmenter, overlayMask } from '@nutrilens/food-segmentation';

const seg = await SlimSamSegmenter.load(ort, encoderUrlOrBytes, decoderUrlOrBytes);
await seg.setImage(rawImage);                          // ~1.7 s CPU, once
const m = await seg.segment([{ x: 640, y: 400 }]);     // ~90 ms per prompt
// m → { mask: Uint8Array(0/1), areaPx, areaFraction, iou, bbox }
overlayMask(m.mask, displayImage);                     // tint for UI
```

- Coordinates are original-image pixels; scaling to SAM's 1024-frame is internal.
- Best of the 3 SAM mask hypotheses is chosen by predicted IoU.
- Masks are cleaned automatically: largest 4-connected component + hole filling.

### Standalone mask utilities

`largestComponent(mask, w, h)`, `fillHoles(mask, w, h)`, `cleanMask(mask, w, h)`,
`maskBBox(mask, w, h)`, `overlayMask(mask, img, rgb, alpha)` — pure JS, usable
with any 0/1 mask regardless of where it came from.

MIT license.
