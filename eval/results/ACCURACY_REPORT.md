# NutriLens Accuracy Report

Generated 2026-07-11T06:49:35.293Z · Swin variant: **int8** · runtime: onnxruntime-node (same library code as the browser build)
Datasets: Food-101 official validation subsample (2523 images, 25/class), extended Indian-food set (259 images).

## Headline results

| Metric | Food-101 subsample | Extended (Indian) set |
|---|---|---|
| Closed-set head (Swin) top-1 | 90.2% | n/a (classes outside Food-101) |
| Closed-set head (Swin) top-5 | 98.5% | n/a |
| Zero-shot head (MobileCLIP-S0) top-1 | 0.4% | 0.4% |
| Zero-shot head top-5 | 1.9% | 2.7% |
| **Fused (shipped defaults)** top-1 | **65.7%** | **23.6%** |
| Fused (shipped defaults) top-5 | 91.8% | 36.3% |
| Fused (best swept params) top-1 | 89.8% | 34.0% |
| False "not food" rate | 5.4% | 7.3% |

Best swept fusion parameters: wSwin=0.88, oovBias=-1 (balanced top-1 61.9%).

## Confidence calibration (fused, best params, Food-101)

Expected Calibration Error (10 bins): **0.278**

| Confidence bin | n | mean confidence | accuracy |
|---|---|---|---|
| 0.0–0.1 | 11 | 7.5% | 9.1% |
| 0.1–0.2 | 40 | 15.2% | 27.5% |
| 0.2–0.3 | 58 | 25.3% | 50.0% |
| 0.3–0.4 | 101 | 35.2% | 45.5% |
| 0.4–0.5 | 159 | 45.5% | 67.9% |
| 0.5–0.6 | 456 | 56.1% | 90.6% |
| 0.6–0.7 | 966 | 65.0% | 97.2% |
| 0.7–0.8 | 611 | 73.7% | 98.0% |
| 0.8–0.9 | 109 | 83.4% | 99.1% |
| 0.9–1.0 | 12 | 92.4% | 100.0% |

## Hardest classes (fused top-1, Food-101)

| Class | n | accuracy |
|---|---|---|
| bread-pudding | 25 | 56.0% |
| steak | 25 | 60.0% |
| pork-chop | 25 | 64.0% |
| filet-mignon | 25 | 68.0% |
| foie-gras | 25 | 68.0% |
| pulled-pork-sandwich | 25 | 68.0% |
| ceviche | 25 | 72.0% |
| chocolate-mousse | 25 | 72.0% |
| chicken-curry | 25 | 76.0% |
| prime-rib | 25 | 76.0% |
| apple-pie | 25 | 80.0% |
| baby-back-ribs | 25 | 80.0% |

## Extended set per class

| Class | n | accuracy |
|---|---|---|
| chana-masala | 20 | 0.0% |
| chapati | 19 | 0.0% |
| dal | 20 | 0.0% |
| dosa | 20 | 0.0% |
| idli | 20 | 0.0% |
| jalebi | 20 | 0.0% |
| naan | 20 | 0.0% |
| pakora | 20 | 0.0% |
| dumplings | 20 | 75.0% |
| fried-rice | 20 | 85.0% |
| hamburger | 20 | 85.0% |
| samosa | 20 | 95.0% |
| pizza | 20 | 100.0% |

## Fusion parameter sweep (top-1, balanced)

| wSwin | oovBias | Food-101 | Extended | balanced |
|---|---|---|---|---|
| 0.88 | -1 | 89.8% | 34.0% | 61.9% |
| 0.88 | -0.6 | 88.9% | 33.6% | 61.3% |
| 0.88 | -0.35 | 88.2% | 33.6% | 60.9% |
| 0.8 | -1 | 86.9% | 33.6% | 60.3% |
| 0.88 | -0.1 | 86.5% | 32.4% | 59.5% |
| 0.8 | -0.6 | 84.2% | 32.8% | 58.5% |
| 0.88 | 0.2 | 83.4% | 31.7% | 57.5% |
| 0.72 | -1 | 80.5% | 31.7% | 56.1% |
| 0.8 | -0.35 | 81.2% | 30.9% | 56.1% |
| 0.8 | -0.1 | 76.8% | 28.6% | 52.7% |
