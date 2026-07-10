# @nutrilens/image-preprocess

Dependency-free image preprocessing and classic computer-vision primitives for
ML pipelines that must produce **bit-identical results in the browser and in
Node** (the key to trustworthy offline evaluation of an in-browser model).

All functions operate on a plain `RawImage` record — `{ data: Uint8ClampedArray
(RGBA), width, height }` — so nothing here depends on DOM, Canvas, sharp or any
runtime-specific type. In the browser, `toRawImage()` decodes Blobs/elements
(EXIF-aware); in Node, decode with any library (e.g. sharp) and hand over the
raw RGBA buffer.

## API

| Function | Purpose |
|---|---|
| `toRawImage(source, {maxSide})` | Browser-only decode of Blob/File/Image/Canvas/ImageBitmap → RawImage, EXIF-rotated |
| `resizeBilinear(img, w, h)` | Bilinear resample (half-pixel centers, PIL-compatible) |
| `resizeBicubic(img, w, h)` | Catmull-Rom bicubic (matches training-time PIL BICUBIC; use for ViT/Swin models) |
| `resizeShortestSide(img, s)` | Aspect-preserving resize (CLIP-style) |
| `centerCrop(img, w, h)` / `crop(img, x, y, w, h)` | Cropping (clamped) |
| `padTo(img, w, h, fill)` | Right/bottom constant padding (SAM-style) |
| `toTensor(img, {mean, std, rescale, layout})` | RGBA → normalized Float32 NCHW/NHWC tensor |
| `toGrayscale(img)` | Luma plane (Float32) |
| `sobel(gray)` / `boxBlur(plane, r)` / `otsuThreshold(data)` | CV primitives for custom pipelines |
| `putToCanvas(img, ctx)` | Browser display helper |

## Example

```js
import { toRawImage, resizeBicubic, toTensor } from '@nutrilens/image-preprocess';

const raw = await toRawImage(file, { maxSide: 1280 });
const t = toTensor(resizeBicubic(raw, 224, 224), {
  mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225],
});
// t.data → Float32Array, t.dims → [1, 3, 224, 224]
```

MIT license. Zero dependencies. ~9 KB min.
