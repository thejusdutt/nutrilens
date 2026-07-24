/**
 * Canonical nutrient table: our key → [FNDDS nutrient name, display name, unit,
 * FDA adult Daily Value in that unit].
 *
 * Lives in its own module so the database build and the provenance test agree
 * by construction — a test that re-declared these names could not detect a
 * wrong one (that is how `sugars` shipped empty for every food: it was mapped
 * to "Sugars, Total", nutrient_nbr 269.3, which no FNDDS food row uses).
 *
 * The FNDDS names must match `nutrient.csv`.`name` exactly.
 */
export const NUTRIENT_MAP = {
  kcal:        ['Energy',                             'Calories',      'kcal', 2000],
  protein:     ['Protein',                            'Protein',       'g',    50],
  fat:         ['Total lipid (fat)',                  'Fat',           'g',    78],
  carbs:       ['Carbohydrate, by difference',        'Carbohydrates', 'g',    275],
  fiber:       ['Fiber, total dietary',               'Fiber',         'g',    28],
  // "Total Sugars" (nbr 269) is what survey-food rows carry; the similarly
  // named "Sugars, Total" (269.3) exists in nutrient.csv but is never used.
  sugars:      ['Total Sugars',                       'Sugars',        'g',    null],
  satFat:      ['Fatty acids, total saturated',       'Saturated fat', 'g',    20],
  monoFat:     ['Fatty acids, total monounsaturated', 'Monounsaturated fat', 'g', null],
  polyFat:     ['Fatty acids, total polyunsaturated', 'Polyunsaturated fat', 'g', null],
  cholesterol: ['Cholesterol',                        'Cholesterol',   'mg',   300],
  sodium:      ['Sodium, Na',                         'Sodium',        'mg',   2300],
  potassium:   ['Potassium, K',                       'Potassium',     'mg',   4700],
  calcium:     ['Calcium, Ca',                        'Calcium',       'mg',   1300],
  iron:        ['Iron, Fe',                           'Iron',          'mg',   18],
  magnesium:   ['Magnesium, Mg',                      'Magnesium',     'mg',   420],
  phosphorus:  ['Phosphorus, P',                      'Phosphorus',    'mg',   1250],
  zinc:        ['Zinc, Zn',                           'Zinc',          'mg',   11],
  copper:      ['Copper, Cu',                         'Copper',        'mg',   0.9],
  selenium:    ['Selenium, Se',                       'Selenium',      'µg',   55],
  vitA:        ['Vitamin A, RAE',                     'Vitamin A',     'µg',   900],
  vitC:        ['Vitamin C, total ascorbic acid',     'Vitamin C',     'mg',   90],
  vitD:        ['Vitamin D (D2 + D3)',                'Vitamin D',     'µg',   20],
  vitE:        ['Vitamin E (alpha-tocopherol)',       'Vitamin E',     'mg',   15],
  vitK:        ['Vitamin K (phylloquinone)',          'Vitamin K',     'µg',   120],
  thiamin:     ['Thiamin',                            'Thiamin (B1)',  'mg',   1.2],
  riboflavin:  ['Riboflavin',                         'Riboflavin (B2)', 'mg', 1.3],
  niacin:      ['Niacin',                             'Niacin (B3)',   'mg',   16],
  vitB6:       ['Vitamin B-6',                        'Vitamin B6',    'mg',   1.7],
  folate:      ['Folate, DFE',                        'Folate',        'µg',   400],
  vitB12:      ['Vitamin B-12',                       'Vitamin B12',   'µg',   2.4],
  choline:     ['Choline, total',                     'Choline',       'mg',   550],
};

/** Rounding applied to every per-100 g value written to the database. */
export const roundPer100g = (v) => Math.round(v * 100) / 100;
