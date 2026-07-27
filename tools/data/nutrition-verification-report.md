# Claude × USDA nutrition cross-verification

Model: `eu.anthropic.claude-sonnet-5` · foods checked: 238 · prompt v1

| outcome | count |
|---|---|
| agree (two-source confirmed) | 121 |
| corrected toward Claude | 18 |
| flagged, USDA kept | 99 |
| Claude estimate unusable | 0 |

Two-source agreement rate: **51%** of usable estimates.

## Biggest disagreements (by kcal gap)

| food | USDA kcal | Claude kcal | gap | USDA Atwater err | Claude Atwater err | more consistent | action |
|---|---|---|---|---|---|---|---|
| Green chutney | 11.5 | 66 | 83% | 0.3 | 0.9 | tie | disagreement, neither clearly better: USDA kept, review |
| Clam chowder | 35 | 133 | 74% | 1.1 | 0.1 | tie | disagreement, neither clearly better: USDA kept, review |
| Crème brûlée | 113 | 363 | 69% | 0.1 | 1.5 | tie | disagreement, neither clearly better: USDA kept, review |
| Tomato soup | 19 | 59 | 68% | 0.1 | 1.1 | tie | disagreement, neither clearly better: USDA kept, review |
| Breakfast cereal | 379 | 135 | 64% | 15.4 | 1.7 | claude | corrected toward Claude (w=0.6) |
| Fruit salad | 133 | 55 | 59% | 1.8 | 2.4 | tie | disagreement, neither clearly better: USDA kept, review |
| Beet salad | 53 | 127 | 58% | 0.6 | 1.6 | tie | disagreement, neither clearly better: USDA kept, review |
| Pakora | 125 | 297 | 58% | 3.8 | 10.5 | usda | disagreement, neither clearly better: USDA kept, review |
| Refried beans | 90 | 201 | 55% | 5.2 | 0.7 | claude | golden-anchored: USDA kept, disagreement logged |
| Kebab | 122 | 269 | 55% | 0.2 | 6.8 | usda | disagreement, neither clearly better: USDA kept, review |
| Gazpacho | 26 | 57 | 54% | 1.1 | 0.6 | tie | golden-anchored: USDA kept, disagreement logged |
| Peking duck | 154 | 337 | 54% | 1.6 | 1.1 | tie | disagreement, neither clearly better: USDA kept, review |
| Falafel | 514 | 242 | 53% | 3.9 | 7 | usda | disagreement, neither clearly better: USDA kept, review |
| Greek salad | 48 | 101 | 52% | 2.3 | 1.2 | tie | disagreement, neither clearly better: USDA kept, review |
| Seaweed salad | 41 | 85 | 52% | 7.8 | 3.3 | claude | corrected toward Claude (w=0.6) |
| Pozole | 43 | 87 | 51% | 1.8 | 0.6 | tie | disagreement, neither clearly better: USDA kept, review |
| Onion chutney | 82.07 | 161 | 49% | 1.3 | 2.4 | tie | disagreement, neither clearly better: USDA kept, review |
| Kung pao chicken | 129 | 248 | 48% | 2.7 | 4.9 | tie | disagreement, neither clearly better: USDA kept, review |
| Biryani | 104 | 198 | 47% | 2 | 6.3 | usda | disagreement, neither clearly better: USDA kept, review |
| Corn on the cob | 119 | 223 | 47% | 9.4 | 0.2 | claude | corrected toward Claude (w=0.6) |
| Kheer | 108 | 202 | 47% | 2.8 | 0.9 | tie | disagreement, neither clearly better: USDA kept, review |
| Green salad | 23 | 43 | 47% | 2.8 | 1 | tie | disagreement, neither clearly better: USDA kept, review |
| Dumplings | 113 | 206 | 45% | 2.1 | 8.4 | usda | disagreement, neither clearly better: USDA kept, review |
| Coconut chutney | 159.3 | 290 | 45% | 1.6 | 1 | tie | disagreement, neither clearly better: USDA kept, review |
| Escargots | 158 | 280 | 44% | 5.9 | 2.3 | claude | corrected toward Claude (w=0.6) |
| Upma | 87 | 154 | 44% | 2.7 | 4.4 | tie | disagreement, neither clearly better: USDA kept, review |
| Wonton soup | 33 | 58 | 43% | 0.5 | 1.9 | tie | disagreement, neither clearly better: USDA kept, review |
| Rajma | 177 | 104 | 41% | 11.1 | 0.1 | claude | corrected toward Claude (w=0.6) |
| Udon | 90 | 54 | 40% | 2.4 | 1.1 | tie | disagreement, neither clearly better: USDA kept, review |
| Pesto pasta | 125 | 207 | 40% | 4.9 | 3.9 | tie | disagreement, neither clearly better: USDA kept, review |
| Chocolate mousse | 212 | 347 | 39% | 4.6 | 10.8 | usda | disagreement, neither clearly better: USDA kept, review |
| Mussels | 109 | 178 | 39% | 4.5 | 4 | tie | disagreement, neither clearly better: USDA kept, review |
| Satay | 151 | 244 | 38% | 0 | 5.3 | usda | disagreement, neither clearly better: USDA kept, review |
| Lobster bisque | 75 | 120 | 38% | 0.8 | 1 | tie | disagreement, neither clearly better: USDA kept, review |
| Sushi | 94 | 150 | 37% | 4.7 | 4 | tie | golden-anchored: USDA kept, disagreement logged |
| Bibimbap | 76 | 121 | 37% | 1.8 | 2.5 | tie | disagreement, neither clearly better: USDA kept, review |
| Chicken curry | 107 | 168 | 36% | 0.6 | 3.3 | tie | golden-anchored: USDA kept, disagreement logged |
| Pho | 37 | 58 | 36% | 0.3 | 2.5 | tie | disagreement, neither clearly better: USDA kept, review |
| Prime rib | 206 | 320 | 36% | 2.2 | 2.4 | tie | disagreement, neither clearly better: USDA kept, review |
| Ravioli | 98 | 152 | 36% | 2.9 | 6.2 | usda | disagreement, neither clearly better: USDA kept, review |

_USDA Atwater err = how far USDA's own kcal is from its own macros. A large value means the USDA row itself does not add up — usually a mis-map — and is the signal used to prefer Claude._