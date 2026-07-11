# NutriLens Accuracy Report

Generated 2026-07-11T07:53:49.445Z · Swin variant: **int8** · runtime: onnxruntime-node (same library code as the browser build)
Datasets: Food-101 official validation subsample (2523 images, 25/class), extended Indian-food set (259 images).

## Headline results

| Metric | Food-101 subsample | Extended (Indian) set |
|---|---|---|
| Closed-set head (Swin) top-1 | 90.2% | n/a (classes outside Food-101) |
| Closed-set head (Swin) top-5 | 98.5% | n/a |
| Zero-shot head (MobileCLIP-S2) top-1 | 83.2% | 83.8% |
| Zero-shot head top-5 | 97.0% | 97.7% |
| **Fused (shipped defaults)** top-1 | **90.4%** | **82.6%** |
| Fused (shipped defaults) top-5 | 98.5% | 96.9% |
| Fused (best swept params) top-1 | 89.7% | 83.8% |
| False "not food" rate | 0.1% | 0.0% |

Best swept fusion parameters: wSwin=0.55, oovBias=-1 (balanced top-1 86.8%).

## Confidence calibration (fused, best params, Food-101)

Expected Calibration Error (10 bins): **0.016**

| Confidence bin | n | mean confidence | accuracy |
|---|---|---|---|
| 0.1–0.2 | 2 | 18.4% | 50.0% |
| 0.2–0.3 | 13 | 25.2% | 15.4% |
| 0.3–0.4 | 31 | 35.7% | 35.5% |
| 0.4–0.5 | 70 | 45.8% | 50.0% |
| 0.5–0.6 | 111 | 54.9% | 48.6% |
| 0.6–0.7 | 89 | 65.4% | 61.8% |
| 0.7–0.8 | 114 | 75.6% | 66.7% |
| 0.8–0.9 | 180 | 85.6% | 78.3% |
| 0.9–1.0 | 1913 | 98.7% | 98.7% |

## Hardest classes (fused top-1, Food-101)

| Class | n | accuracy |
|---|---|---|
| steak | 25 | 60.0% |
| chicken-curry | 25 | 64.0% |
| pork-chop | 25 | 64.0% |
| spring-rolls | 25 | 64.0% |
| bread-pudding | 25 | 72.0% |
| chocolate-mousse | 25 | 72.0% |
| falafel | 25 | 72.0% |
| grilled-salmon | 24 | 75.0% |
| ceviche | 25 | 76.0% |
| filet-mignon | 25 | 76.0% |
| lasagna | 25 | 76.0% |
| prime-rib | 25 | 76.0% |

## Extended set per class

| Class | n | accuracy |
|---|---|---|
| naan | 20 | 60.0% |
| chana-masala | 20 | 70.0% |
| dal | 20 | 70.0% |
| dosa | 20 | 70.0% |
| chapati | 19 | 73.7% |
| dumplings | 20 | 75.0% |
| hamburger | 20 | 90.0% |
| idli | 20 | 90.0% |
| fried-rice | 20 | 95.0% |
| pakora | 20 | 95.0% |
| jalebi | 20 | 100.0% |
| pizza | 20 | 100.0% |
| samosa | 20 | 100.0% |

## Fusion parameter sweep (top-1, balanced)

| wSwin | oovBias | Food-101 | Extended | balanced |
|---|---|---|---|---|
| 0.55 | -1 | 89.7% | 83.8% | 86.8% |
| 0.55 | -0.6 | 88.9% | 84.6% | 86.7% |
| 0.65 | -1 | 90.4% | 83.0% | 86.7% |
| 0.65 | -0.6 | 89.3% | 83.8% | 86.6% |
| 0.72 | -1 | 90.4% | 82.6% | 86.5% |
| 0.72 | -0.35 | 88.7% | 84.2% | 86.4% |
| 0.8 | -1 | 90.9% | 81.9% | 86.4% |
| 0.65 | -0.35 | 88.5% | 84.2% | 86.4% |
| 0.8 | -0.6 | 89.9% | 82.6% | 86.3% |
| 0.8 | -0.35 | 89.1% | 83.4% | 86.2% |
