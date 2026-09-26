# MyFitnessPal parity

Every feature in MyFitnessPal's own plan table
([support.myfitnesspal.com, "The difference between Free, Premium, and Premium+"](https://support.myfitnesspal.com/hc/en-us/articles/34889191368077-The-difference-between-Free-Premium-and-Premium),
read 2026-09-26), plus the everyday settings that table does not list, against
NutriLens — which runs with no account, no server and no network after install.

**Present** means a test drives the feature in the built app with every
non-localhost request blocked, and the numbers come out right against an
independent oracle. The test is named in the last column:
`parity` = `npm run test:parity` (eval/parity-e2e.mjs, 101 checks),
`tracker` = `npm run test:tracker`, `offline` = `npm run test:offline`,
`sides` = `npm run test:sides`, `unit` = `npm test`.

## Free in MyFitnessPal

| Feature | NutriLens | Test |
|---|---|---|
| Food & exercise logging | Present — search 1,982 foods, recent, frequent; cardio and strength (sets × reps) | parity: log, persist, recent · exercise |
| Log measurements & view past progress | Present — weight, waist, hips, chest, arm, body fat; weight chart and goal progress | parity: weight and progress · tracker |
| Create foods, meals & recipes | Present — foods from a label, meals saved from a day, recipes divided into servings | parity: custom food lifecycle · saved meal · tracker: recipe |
| View macronutrients | Present — day and week, against goal | parity: macro goals · nutrition dashboard |
| Calorie & macro goals by percentage | Present — computed from Mifflin-St Jeor, or a manual override | parity: goals · macro goals |
| Share / view your diary with others | Out of scope — needs an account and a server | — |
| Linking to partner apps | Out of scope — needs a server; no wearable sync | — |
| Printable report | Present — the day or week on screen, every meal and daily totals, printed with the app hidden | parity: food analysis and report |

## Premium in MyFitnessPal

| Feature | NutriLens | Test |
|---|---|---|
| Ad free | Present — there are no ads | — |
| Macros by gram | Present | parity: macro goals |
| Food analysis | Present — top foods by calories or any nutrient, day or week | parity: food analysis and report |
| Quick-add macros | Present — calories plus protein, carbs, fat | parity: quick add |
| Different goals by day | Present — a calorie goal per weekday | parity: goals by weekday |
| Exercise calorie settings | Present — add exercise calories back, or not | parity: exercise · tracker |
| Home screen dashboard | Present — the diary is the dashboard (remaining, macros, meals, habits) | parity, tracker |
| Priority customer support | Not applicable | — |
| Data export | Present — diary CSV and a full backup that restores everything | parity: export CSV · backup round trip |
| Macros by meal / calorie goals by meal | Calorie goals by meal present (a share of the day per meal, shown on each meal header). Macros by meal: not yet | parity: meal names and goals |
| Unlimited daily digests | Partly — the nutrition week view and five-week projection on finishing a day; no pushed digest | parity: complete day · nutrition dashboard |
| Food timestamps | Present — each entry shows and can set the time eaten | parity: timestamps and multi-day |
| Recipe discovery | Out of scope — no recipe catalogue ships | — |
| Workout routines | Present — save a day's exercise as a routine, log it on another day | parity: workout routines |
| Net carbs | Present — optional carbs minus fibre on the macro card and dashboard | parity: net carbs and nutrient goals |
| Meal scan | Present — on-device photo recognition, main dish plus usual sides | sides · parity: photo to diary · offline |
| Barcode scanner | Present — bundled table of 134k products, no network | tracker · offline |
| Intermittent fasting | Present — start, target, wall-clock timer across reloads, history | parity: fasting |
| Multi-day logging | Present — add a food to the following days in one save | parity: timestamps and multi-day |
| Sync food names to Fitbit | Out of scope — no wearable sync | — |

## Premium+ in MyFitnessPal

| Feature | NutriLens | Test |
|---|---|---|
| Meal plan builder, meal prep mode, diet preference | Out of scope for now (recorded in 2026-07 as not built) | — |
| Grocery lists & grocery shopping services | Out of scope — shopping needs a network | — |

## Settings MyFitnessPal has that its plan table does not list

| Feature | NutriLens | Test |
|---|---|---|
| Units: kg / lb, cm / in, kcal / kJ | Present — stored metric and in kcal; only display and input convert | parity: units |
| Rename meals | Present — the four meals, everywhere they are named | parity: meal names and goals |
| Nutrient goals (fibre, sodium, sugar…) | Present — own targets, FDA Daily Value otherwise | parity: net carbs and nutrient goals |
| Water, steps, notes, finish the day | Present — persist across reloads | parity: habits and notes persist · complete day |
| Copy a meal from or to another day, move an entry | Present | parity: copy meals · move entry |
| Reminders | Out of scope — a web app cannot fire a notification while closed without a push server | — |
| Voice logging | Out of scope — recorded in 2026-07 as not built | — |
| Friends, forums, challenges | Out of scope — needs accounts and a server | — |

## Found by this testing

Two bugs the earlier tests did not reach, both fixed:

- **Diary cards overwrote each other.** Every card (water, steps, weight, note,
  finish) wrote back the whole day record as it was when the screen was drawn,
  so entering steps and then saving a note put the step count back to 0.
  Fixed with `db.patchDay`, which reads and writes one field in a single
  transaction.
- **Quick water taps were lost.** Three taps in a row each read the count
  before the previous save finished and one glass was kept. The count now
  updates before the save.
