# NutriLens Accuracy Report

Generated 2026-07-17T16:00:21.669Z · Swin variant: **int8** · runtime: onnxruntime-node (same library code as the browser build)
Datasets: Food-101 official validation subsample (2523 images, 25/class), extended Indian-food set (259 images).

## Headline results

| Metric | Food-101 subsample | Extended (Indian) set |
|---|---|---|
| Closed-set head (Swin) top-1 | 90.2% | n/a (classes outside Food-101) |
| Closed-set head (Swin) top-5 | 98.5% | n/a |
| Zero-shot head (MobileCLIP-S2) top-1 | 82.2% | 80.7% |
| Zero-shot head top-5 | 96.8% | 98.1% |
| **Fused (shipped defaults)** top-1 | **90.4%** | **81.1%** |
| Fused (shipped defaults) top-5 | 98.4% | 96.5% |
| Fused (best swept params) top-1 | 88.3% | 82.2% |
| False "not food" rate | 0.1% | 0.0% |

Best swept fusion parameters: wSwin=0.65, oovBias=-0.35 (balanced top-1 78.2%).

## Per-cuisine accuracy (fused, shipped defaults)

Rows combine the Food-101 slice for that cuisine with its dedicated eval set
(rajistics Indian images; Wikimedia Commons for Mexican/Spanish/Chinese/…).

| Cuisine | n | top-1 | top-5 | false "not food" |
|---|---|---|---|---|
| indian | 369 | 76.7% | 95.4% | 0.0% |
| mexican | 277 | 70.0% | 87.4% | 0.4% |
| chinese | 234 | 77.8% | 95.3% | 0.4% |
| japanese | 175 | 92.6% | 99.4% | 0.0% |
| spanish | 125 | 72.8% | 92.0% | 0.0% |
| korean | 25 | 96.0% | 100.0% | 0.0% |
| thai | 25 | 96.0% | 100.0% | 0.0% |
| vietnamese | 25 | 100.0% | 100.0% | 0.0% |

### Per-class accuracy inside dedicated cuisine sets (fused, defaults)

| Cuisine | Class | n | top-1 |
|---|---|---|---|
| chinese | wonton-soup | 15 | 40.0% |
| chinese | baozi | 15 | 46.7% |
| chinese | kung-pao-chicken | 15 | 53.3% |
| chinese | mapo-tofu | 10 | 60.0% |
| chinese | chow-mein | 15 | 73.3% |
| chinese | sweet-and-sour-pork | 9 | 77.8% |
| chinese | general-tso-chicken | 15 | 80.0% |
| chinese | congee | 15 | 86.7% |
| indian | biryani | 15 | 26.7% |
| indian | paratha | 15 | 26.7% |
| indian | vada | 15 | 73.3% |
| indian | gulab-jamun | 15 | 80.0% |
| mexican | enchiladas | 15 | 13.3% |
| mexican | refried-beans | 15 | 20.0% |
| mexican | chilaquiles | 15 | 33.3% |
| mexican | mexican-rice | 9 | 33.3% |
| mexican | fajitas | 15 | 46.7% |
| mexican | taquitos | 15 | 46.7% |
| mexican | burrito-bowl | 13 | 53.8% |
| mexican | pozole | 15 | 66.7% |
| mexican | tamales | 15 | 73.3% |
| spanish | empanadas | 15 | 40.0% |
| spanish | gazpacho | 15 | 46.7% |
| spanish | croquetas | 15 | 60.0% |
| spanish | tortilla-espanola | 15 | 66.7% |
| spanish | patatas-bravas | 15 | 86.7% |

## Confidence calibration (fused, best params, Food-101)

Expected Calibration Error (10 bins): **0.015**

| Confidence bin | n | mean confidence | accuracy |
|---|---|---|---|
| 0.1–0.2 | 2 | 16.5% | 0.0% |
| 0.2–0.3 | 16 | 26.1% | 25.0% |
| 0.3–0.4 | 44 | 36.0% | 29.5% |
| 0.4–0.5 | 92 | 45.1% | 45.7% |
| 0.5–0.6 | 116 | 54.8% | 56.9% |
| 0.6–0.7 | 117 | 64.9% | 62.4% |
| 0.7–0.8 | 134 | 75.4% | 64.9% |
| 0.8–0.9 | 198 | 85.3% | 80.3% |
| 0.9–1.0 | 1804 | 98.5% | 98.8% |

## Hardest classes (fused top-1, Food-101)

| Class | n | accuracy |
|---|---|---|
| chicken-curry | 25 | 60.0% |
| spring-rolls | 25 | 64.0% |
| steak | 25 | 64.0% |
| pork-chop | 25 | 64.0% |
| bread-pudding | 25 | 68.0% |
| ceviche | 25 | 72.0% |
| chocolate-mousse | 25 | 72.0% |
| falafel | 25 | 72.0% |
| foie-gras | 25 | 72.0% |
| grilled-salmon | 24 | 75.0% |
| beet-salad | 25 | 76.0% |
| breakfast-burrito | 25 | 76.0% |

## Extended set per class

| Class | n | accuracy |
|---|---|---|
| naan | 20 | 60.0% |
| chapati | 19 | 63.2% |
| dal | 20 | 65.0% |
| chana-masala | 20 | 70.0% |
| dumplings | 20 | 70.0% |
| dosa | 20 | 75.0% |
| idli | 20 | 85.0% |
| fried-rice | 20 | 90.0% |
| hamburger | 20 | 90.0% |
| jalebi | 20 | 100.0% |
| pakora | 20 | 100.0% |
| pizza | 20 | 100.0% |
| samosa | 20 | 100.0% |

## Fusion parameter sweep (top-1, balanced)

| wSwin | oovBias | Food-101 | Extended | balanced |
|---|---|---|---|---|
| 0.65 | -0.35 | 88.3% | 82.2% | 78.2% |
| 0.65 | -1 | 90.3% | 81.5% | 77.9% |
| 0.55 | -0.6 | 88.5% | 82.6% | 77.9% |
| 0.8 | -0.6 | 89.9% | 81.1% | 77.8% |
| 0.88 | -0.1 | 88.7% | 81.5% | 77.8% |
| 0.72 | -0.1 | 87.5% | 81.5% | 77.8% |
| 0.72 | -0.35 | 88.4% | 82.2% | 77.8% |
| 0.65 | -0.6 | 89.1% | 81.9% | 77.8% |
| 0.8 | -0.35 | 89.1% | 81.5% | 77.7% |
| 0.72 | -0.6 | 89.3% | 81.5% | 77.6% |
