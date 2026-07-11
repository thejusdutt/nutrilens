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
2. **`maskAreaInsideEllipse(mask, w, h, plate)`** — food sits on the plate;
   mask pixels outside the rim (table, shadows, napkins) are clipped before
   any pricing.
3. **`PortionEstimator.estimate(...)`** — converts the clipped pixel area to
   grams: the plate's known diameter (default 26 cm, user-configurable) gives
   cm/px on *both* ellipse axes (foreshortening included, since plane areas
   scale by the product of axis scales). The geometric estimate
   `area_cm² × height-prior × density-prior` is capped at 90% of the plate's
   physical surface, then **shrunk toward the food's typical serving mass in
   log-space** (w≈0.65 on the geometry when the plate fit is confident):
   the geometric model is unbiased but noisy in its height×density assumption,
   the USDA serving statistic is biased-to-mean but low-variance, and their
   log-linear blend has lower expected error than either alone — it also makes
   pathological masks (one bad segmentation claiming a 3,000-kcal plate)
   impossible. Per-food priors (pile height, bulk density, typical serving)
   come from the caller — NutriLens derives them from FNDDS portion statistics
   and FAO/INFOODS density tables.
4. **Fallback** — no plate found → the food's typical serving mass with a wide
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
