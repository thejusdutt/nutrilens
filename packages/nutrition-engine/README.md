# @nutrilens/nutrition-engine

Offline nutrition computation over a compact food database: per-portion scaling
of calories, macro- and micronutrients, % Daily Value, portion-uncertainty
propagation, multi-item aggregation, household measures and fuzzy search — in
~4 KB of dependency-free JS.

The database format is produced from **USDA FoodData Central FNDDS 2021-2023**
(public domain) by `tools/build-nutrition-db.mjs` in the NutriLens monorepo:
211 curated foods × 30 nutrients per 100 g + FNDDS portion weights + physical
priors. Any database following the same shape works:

```jsonc
{
  "nutrients": { "kcal": { "name": "Calories", "unit": "kcal", "rdi": 2000 }, ... },
  "foods": {
    "pizza": {
      "name": "Pizza", "fdcId": 2708614, "fdcDesc": "Pizza, cheese, ...",
      "per100g": { "kcal": 266, "protein": 11.39, ... },
      "portions": [["1 piece, medium pizza", 86], ...],
      "prior": { "heightCm": 1.2, "densityGml": 0.85, "servingG": 240 }
    }
  }
}
```

## API

```js
const engine = new NutritionEngine(db);
engine.forPortion('pizza', 200);                    // scaled nutrients + %DV
engine.forPortionRange('pizza', { grams: 240, low: 150, high: 380 }); // + low/high per nutrient
engine.aggregate([{ id: 'pizza', grams: 200 }, { id: 'green-salad', grams: 80 }]);
engine.portions('pizza');                           // household measures incl. "100 g"
engine.search('chiken tikka');                      // fuzzy, for manual-correction UIs
```

%DV uses FDA adult Daily Values. Nutrition data is informational, not medical
advice.

MIT license (code). Database content: USDA, public domain.
