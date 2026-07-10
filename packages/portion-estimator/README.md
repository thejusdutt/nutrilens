# @nutrilens/portion-estimator

Food portion (mass) estimation from a **single uncalibrated RGB photo**, in the
browser. Exact single-image portion estimation is an open research problem
(published systems use depth sensors or fiducial references); this library
implements the strongest browser-only approximation and is explicit about
uncertainty: every estimate carries a `low`/`high` range and a `method` tag.

## How it works

1. **`detectPlateEllipse(rawImage)`** — custom scale-reference detector:
   downscale → Sobel edges → RANSAC over 4-point samples of the axis-aligned
   conic `Ax² + By² + Cx + Dy = 1` → plausibility gating (size/aspect/position)
   → least-squares refit on inliers. A circular plate seen at a tilt projects
   to exactly this ellipse family (phone photos have ≈0 roll, so axis-aligned
   4-DOF is deliberately chosen over a general 5-DOF conic — far more robust
   on cluttered food edges).
2. **`PortionEstimator.estimate(...)`** — converts a food-mask pixel area to
   grams: the plate's known diameter (default 26 cm, user-configurable) gives
   cm/px on *both* ellipse axes (foreshortening included, since plane areas
   scale by the product of axis scales); `area_cm² × height-prior × density-prior
   = grams`. Per-food priors (pile height, bulk density, typical serving) come
   from the caller — NutriLens derives them from FNDDS portion statistics and
   FAO/INFOODS density tables.
3. **Fallback** — no plate found → the food's typical serving mass with a wide
   (×/÷2) band, tagged `serving-prior` so UIs can prompt the user to adjust.

```js
import { detectPlateEllipse, PortionEstimator } from '@nutrilens/portion-estimator';

const plate = detectPlateEllipse(rawImage);            // ~70 ms at 360 px
const est = new PortionEstimator({ plateDiameterCm: 26 }).estimate({
  areaPx: mask.areaPx, imageWidth: img.width, imageHeight: img.height,
  plate, prior: { heightCm: 3, densityGml: 0.8, servingG: 250 },
});
// → { grams: 342, low: 214, high: 547, method: 'plate-scale', areaCm2: 152, plateConfidence: 0.71 }
```

Always give users a manual serving-size control — this library's job is a good
starting point plus an honest error bar, not false precision.

MIT license. Depends on `@nutrilens/image-preprocess`.
