/**
 * Canonical NutriLens food vocabulary.
 *
 * Every entry:
 *   id     canonical kebab-case id (stable across app, DB, embeddings)
 *   name   display name
 *   cat    coarse category (drives default physical priors)
 *   f101   Food-101 class name if this food is in the closed-set head, else undefined
 *   syn    prompt synonyms for CLIP text-embedding ensembling (besides `name`)
 *   fndds  substring query (all tokens must match) selecting the FNDDS food;
 *          string or array of fallbacks tried in order
 *   h      typical pile height on a plate, cm (overrides category default)
 *   rho    bulk density g/cm³ (overrides category default)
 *   serve  typical serving mass g (overrides FNDDS portion median)
 *
 * Sources for priors: FNDDS portion weights, FAO/INFOODS density tables,
 * common-sense food geometry. They feed portion estimation only — nutrition
 * values always come from FNDDS per-100g data.
 */

/** Category defaults: [heightCm, densityGml, serveG] */
export const CATEGORY_PRIORS = {
  'flat':      [1.2, 0.85, 150],  // pizza, flatbreads, pancakes
  'pile':      [3.0, 0.80, 250],  // rice, noodles, curries on plate
  'salad':     [4.0, 0.35, 150],
  'soup':      [4.0, 1.00, 350],
  'meat':      [2.5, 1.05, 170],
  'seafood':   [2.2, 1.00, 150],
  'sandwich':  [6.0, 0.55, 220],
  'cake':      [5.0, 0.60, 120],
  'dessert':   [3.5, 0.80, 130],
  'pastry':    [4.0, 0.45, 90],
  'fruit':     [5.0, 0.90, 150],
  'vegetable': [3.0, 0.60, 120],
  'egg':       [2.5, 0.95, 120],
  'drink':     [8.0, 1.00, 300],
  'snack':     [3.0, 0.50, 100],
};

/* eslint-disable max-len */
export const VOCABULARY = [
  // ============================= Food-101 (closed-set head) =============================
  { id: 'apple-pie', name: 'Apple pie', cat: 'cake', f101: 'apple_pie', syn: ['slice of apple pie'], fndds: ['Pie, apple'], serve: 155 },
  { id: 'baby-back-ribs', name: 'Baby back ribs', cat: 'meat', f101: 'baby_back_ribs', syn: ['pork ribs', 'barbecue ribs'], fndds: ['Ribs, NFS'], serve: 280 },
  { id: 'baklava', name: 'Baklava', cat: 'pastry', f101: 'baklava', fndds: 'Baklava', serve: 78 },
  { id: 'beef-carpaccio', name: 'Beef carpaccio', cat: 'meat', f101: 'beef_carpaccio', syn: ['raw beef carpaccio'], fndds: ['Beef, raw'], h: 0.5, serve: 100 },
  { id: 'beef-tartare', name: 'Beef tartare', cat: 'meat', f101: 'beef_tartare', syn: ['steak tartare'], fndds: ['Beef, raw'], h: 2.5, serve: 150 },
  { id: 'beet-salad', name: 'Beet salad', cat: 'salad', f101: 'beet_salad', fndds: ['Beet salad', 'Beets, cooked'], serve: 150 },
  { id: 'beignets', name: 'Beignets', cat: 'pastry', f101: 'beignets', syn: ['powdered sugar beignets'], fndds: ['Fritter, NFS', 'Doughnut, NFS'], serve: 90 },
  { id: 'bibimbap', name: 'Bibimbap', cat: 'pile', f101: 'bibimbap', syn: ['korean bibimbap rice bowl'], fndds: ['Bibimbap, Korean'], serve: 400 },
  { id: 'bread-pudding', name: 'Bread pudding', cat: 'dessert', f101: 'bread_pudding', fndds: 'Bread pudding', serve: 150 },
  { id: 'breakfast-burrito', name: 'Breakfast burrito', cat: 'sandwich', f101: 'breakfast_burrito', syn: ['egg breakfast burrito'], fndds: ['Burrito with egg', 'Burrito, NFS'], serve: 220 },
  { id: 'bruschetta', name: 'Bruschetta', cat: 'flat', f101: 'bruschetta', syn: ['tomato bruschetta'], fndds: ['Bruschetta'], h: 3, serve: 90 },
  // FNDDS only lists caesar salad *without* dressing (77 kcal/100 g). Nobody
  // eats it that way, and the undressed row made a restaurant caesar look like
  // a bowl of lettuce. Composed at the ratio a kitchen actually uses.
  { id: 'caesar-salad', name: 'Caesar salad', cat: 'salad', f101: 'caesar_salad', mix: [['Caesar salad, with romaine, no dressing', 0.84], ['Caesar dressing', 0.16]], serve: 180 },
  { id: 'cannoli', name: 'Cannoli', cat: 'pastry', f101: 'cannoli', fndds: ['Cannoli', 'Cream puff'], serve: 90 },
  { id: 'caprese-salad', name: 'Caprese salad', cat: 'salad', f101: 'caprese_salad', syn: ['tomato mozzarella salad'], fndds: ['Tomato and mozzarella', 'Mozzarella'], rho: 0.7, serve: 160 },
  { id: 'carrot-cake', name: 'Carrot cake', cat: 'cake', f101: 'carrot_cake', fndds: 'Carrot cake', serve: 110 },
  { id: 'ceviche', name: 'Ceviche', cat: 'seafood', f101: 'ceviche', syn: ['fish ceviche'], fndds: ['Ceviche'], serve: 160 },
  { id: 'cheese-plate', name: 'Cheese plate', cat: 'snack', f101: 'cheese_plate', syn: ['assorted cheese board'], fndds: ['Cheese, NFS'], rho: 1.0, serve: 90 },
  { id: 'cheesecake', name: 'Cheesecake', cat: 'cake', f101: 'cheesecake', fndds: ['Cheesecake, plain', 'Cheesecake'], serve: 125 },
  { id: 'chicken-curry', name: 'Chicken curry', cat: 'pile', f101: 'chicken_curry', syn: ['indian chicken curry'], fndds: ['Chicken curry, Indian', 'Chicken curry'], rho: 0.95, serve: 250 },
  { id: 'chicken-quesadilla', name: 'Quesadilla', cat: 'flat', f101: 'chicken_quesadilla', syn: ['quesadilla', 'cheese quesadilla', 'chicken quesadilla'], fndds: ['Quesadilla, chicken', 'Quesadilla with chicken', 'Quesadilla, NFS'], h: 2, serve: 180 },
  { id: 'chicken-wings', name: 'Chicken wings', cat: 'meat', f101: 'chicken_wings', syn: ['fried chicken wings', 'buffalo wings'], fndds: ['Chicken wing, fried', 'Chicken wings'], serve: 160 },
  { id: 'chocolate-cake', name: 'Chocolate cake', cat: 'cake', f101: 'chocolate_cake', fndds: ['Cake or cupcake, chocolate, no icing', 'Cake or cupcake, chocolate with chocolate icing, bakery'], serve: 110 },
  { id: 'chocolate-mousse', name: 'Chocolate mousse', cat: 'dessert', f101: 'chocolate_mousse', fndds: ['Chocolate mousse', 'Mousse'], serve: 110 },
  { id: 'churros', name: 'Churros', cat: 'pastry', f101: 'churros', fndds: ['Churros'], serve: 80 },
  // Named only, this label was an attractor for any small bowl of pale paste —
  // it outscored coconut chutney on a crop of a chutney bowl. The prompts now
  // mention what is actually in a chowder, which is what tells it apart from
  // every other creamy white thing in a bowl.
  { id: 'clam-chowder', name: 'Clam chowder', cat: 'soup', f101: 'clam_chowder', syn: ['new england clam chowder', 'creamy white soup with clams and potato chunks', 'bowl of thick chowder soup with a spoon'], fndds: ['Clam chowder, NS', 'Clam chowder'], serve: 350 },
  { id: 'club-sandwich', name: 'Club sandwich', cat: 'sandwich', f101: 'club_sandwich', fndds: ['Club sandwich'], serve: 250 },
  { id: 'crab-cakes', name: 'Crab cakes', cat: 'seafood', f101: 'crab_cakes', fndds: ['Crab cake'], serve: 120 },
  { id: 'creme-brulee', name: 'Crème brûlée', cat: 'dessert', f101: 'creme_brulee', syn: ['creme brulee custard'], fndds: ['Creme brulee', 'Custard'], serve: 130 },
  { id: 'croque-madame', name: 'Croque madame', cat: 'sandwich', f101: 'croque_madame', syn: ['ham cheese sandwich with fried egg'], fndds: ['Ham and cheese sandwich', 'Grilled cheese'], serve: 250 },
  { id: 'cupcakes', name: 'Cupcakes', cat: 'cake', f101: 'cup_cakes', syn: ['frosted cupcake'], fndds: ['Cupcake'], serve: 70 },
  { id: 'deviled-eggs', name: 'Deviled eggs', cat: 'egg', f101: 'deviled_eggs', fndds: ['Deviled egg'], serve: 80 },
  { id: 'donuts', name: 'Donuts', cat: 'pastry', f101: 'donuts', syn: ['glazed doughnut'], fndds: ['Doughnut, NFS', 'Doughnut'], serve: 65 },
  { id: 'dumplings', name: 'Dumplings', cat: 'pile', f101: 'dumplings', syn: ['steamed dumplings', 'chinese dumplings', 'dim sum', 'momos', 'pleated steamed dumplings on a plate'], fndds: ['Wonton, dumpling or pot sticker, steamed', 'Dumpling, no meat'], rho: 0.9, serve: 180 },
  { id: 'edamame', name: 'Edamame', cat: 'vegetable', f101: 'edamame', syn: ['edamame soybeans in pods'], fndds: ['Edamame'], serve: 100 },
  { id: 'eggs-benedict', name: 'Eggs Benedict', cat: 'egg', f101: 'eggs_benedict', fndds: ['Egg, Benedict'], serve: 260 },
  { id: 'escargots', name: 'Escargots', cat: 'seafood', f101: 'escargots', syn: ['snails in garlic butter'], fndds: ['Escargot'], serve: 90 },
  { id: 'falafel', name: 'Falafel', cat: 'snack', f101: 'falafel', syn: ['falafel balls'], fndds: ['Falafel'], rho: 0.75, serve: 120 },
  { id: 'filet-mignon', name: 'Filet mignon', cat: 'meat', f101: 'filet_mignon', syn: ['beef tenderloin steak'], fndds: ['Beef steak, NS as to cooking method', 'Beef steak'], h: 4, serve: 200 },
  { id: 'fish-and-chips', name: 'Fish and chips', cat: 'seafood', f101: 'fish_and_chips', syn: ['battered fried fish with french fries'], fndds: ['Fish, battered, fried', 'Fish, fried'], serve: 320 },
  // FNDDS stops at ordinary liver pâté (201 kcal); foie gras is roughly half fat.
  { id: 'foie-gras', name: 'Foie gras', cat: 'meat', f101: 'foie_gras', mix: [['Liver, paste or pate', 0.55], ['Butter, NFS', 0.45]], h: 1.5, serve: 60 },
  { id: 'french-fries', name: 'French fries', cat: 'snack', f101: 'french_fries', syn: ['fries', 'chips'], fndds: ['White potato, french fries, from fast food', 'french fries'], h: 4, rho: 0.45, serve: 130 },
  { id: 'french-onion-soup', name: 'French onion soup', cat: 'soup', f101: 'french_onion_soup', fndds: ['Onion soup, French'], serve: 350 },
  { id: 'french-toast', name: 'French toast', cat: 'flat', f101: 'french_toast', fndds: ['French toast, NFS', 'French toast'], h: 2.5, serve: 130 },
  { id: 'fried-calamari', name: 'Fried calamari', cat: 'seafood', f101: 'fried_calamari', syn: ['calamari rings'], fndds: ['Calamari, fried'], serve: 150 },
  { id: 'fried-rice', name: 'Fried rice', cat: 'pile', f101: 'fried_rice', syn: ['chinese fried rice'], fndds: ['Fried rice, NFS', 'Fried rice'], serve: 300 },
  { id: 'frozen-yogurt', name: 'Frozen yogurt', cat: 'dessert', f101: 'frozen_yogurt', syn: ['froyo swirl'], fndds: ['Frozen yogurt, NFS', 'Frozen yogurt'], serve: 120 },
  { id: 'garlic-bread', name: 'Garlic bread', cat: 'flat', f101: 'garlic_bread', fndds: ['Garlic bread'], h: 3, rho: 0.4, serve: 60 },
  { id: 'gnocchi', name: 'Gnocchi', cat: 'pile', f101: 'gnocchi', syn: ['potato gnocchi'], fndds: ['Gnocchi'], rho: 0.95, serve: 250 },
  { id: 'greek-salad', name: 'Greek salad', cat: 'salad', f101: 'greek_salad', fndds: ['Greek salad'], serve: 180 },
  { id: 'grilled-cheese-sandwich', name: 'Grilled cheese sandwich', cat: 'sandwich', f101: 'grilled_cheese_sandwich', fndds: ['Grilled cheese sandwich'], h: 4, serve: 120 },
  { id: 'grilled-salmon', name: 'Grilled salmon', cat: 'seafood', f101: 'grilled_salmon', syn: ['salmon fillet'], fndds: ['Salmon, grilled', 'Salmon, baked or broiled', 'Salmon, cooked'], h: 3, serve: 170 },
  { id: 'guacamole', name: 'Guacamole', cat: 'snack', f101: 'guacamole', fndds: ['Guacamole, NFS', 'Guacamole'], rho: 0.95, h: 3, serve: 100 },
  { id: 'gyoza', name: 'Gyoza', cat: 'pile', f101: 'gyoza', syn: ['japanese pan-fried dumplings', 'potstickers'], fndds: ['Wonton, dumpling or pot sticker, fried'], h: 2, rho: 0.9, serve: 140 },
  { id: 'hamburger', name: 'Hamburger', cat: 'sandwich', f101: 'hamburger', syn: ['burger', 'cheeseburger'], fndds: ['Cheeseburger, from fast food, 1 medium patty', 'Hamburger, from fast food', 'Hamburger, NFS'], serve: 230 },
  { id: 'hot-and-sour-soup', name: 'Hot and sour soup', cat: 'soup', f101: 'hot_and_sour_soup', fndds: ['Hot and sour soup'], serve: 350 },
  { id: 'hot-dog', name: 'Hot dog', cat: 'sandwich', f101: 'hot_dog', syn: ['hot dog in a bun'], fndds: ['Hot dog sandwich, NFS', 'Frankfurter'], h: 4.5, serve: 150 },
  { id: 'huevos-rancheros', name: 'Huevos rancheros', cat: 'egg', f101: 'huevos_rancheros', fndds: ['Huevos rancheros'], serve: 280 },
  { id: 'hummus', name: 'Hummus', cat: 'snack', f101: 'hummus', fndds: ['Hummus'], rho: 1.0, h: 2.5, serve: 90 },
  { id: 'ice-cream', name: 'Ice cream', cat: 'dessert', f101: 'ice_cream', syn: ['scoops of ice cream'], fndds: ['Ice cream, NFS', 'Ice cream, regular'], rho: 0.6, serve: 100 },
  { id: 'lasagna', name: 'Lasagna', cat: 'pile', f101: 'lasagna', syn: ['lasagne'], fndds: ['Lasagna with meat', 'Lasagna'], h: 4.5, rho: 1.0, serve: 250 },
  { id: 'lobster-bisque', name: 'Lobster bisque', cat: 'soup', f101: 'lobster_bisque', fndds: ['Bisque', 'Lobster'], serve: 320 },
  // 'Lobster salad' is the filling only — 1.2 g carbs for a dish served in a bun.
  { id: 'lobster-roll-sandwich', name: 'Lobster roll', cat: 'sandwich', f101: 'lobster_roll_sandwich', mix: [['Lobster salad', 0.6], ['Roll, white, soft', 0.4]], serve: 200 },
  { id: 'macaroni-and-cheese', name: 'Macaroni and cheese', cat: 'pile', f101: 'macaroni_and_cheese', syn: ['mac and cheese'], fndds: ['Macaroni and cheese, NFS', 'Macaroni or noodles with cheese'], rho: 0.95, serve: 250 },
  { id: 'macarons', name: 'Macarons', cat: 'dessert', f101: 'macarons', syn: ['french macarons'], fndds: ['Macaroon', 'Cookie, NFS'], h: 2.5, rho: 0.6, serve: 45 },
  { id: 'miso-soup', name: 'Miso soup', cat: 'soup', f101: 'miso_soup', fndds: ['Miso soup'], serve: 300 },
  { id: 'mussels', name: 'Mussels', cat: 'seafood', f101: 'mussels', syn: ['steamed mussels in shells'], fndds: ['Mussels'], h: 5, rho: 0.55, serve: 200 },
  { id: 'nachos', name: 'Nachos', cat: 'snack', f101: 'nachos', syn: ['nachos with cheese'], fndds: ['Nachos with cheese', 'Nachos'], h: 5, rho: 0.35, serve: 220 },
  { id: 'omelette', name: 'Omelette', cat: 'egg', f101: 'omelette', syn: ['omelet'], fndds: ['Egg omelet or scrambled egg, NFS', 'omelet'], h: 2, serve: 140 },
  { id: 'onion-rings', name: 'Onion rings', cat: 'snack', f101: 'onion_rings', fndds: ['Fried onion rings'], h: 5, rho: 0.35, serve: 110 },
  { id: 'oysters', name: 'Oysters', cat: 'seafood', f101: 'oysters', syn: ['raw oysters on the half shell'], fndds: ['Oysters, raw', 'Oyster'], h: 2, serve: 120 },
  { id: 'pad-thai', name: 'Pad thai', cat: 'pile', f101: 'pad_thai', syn: ['thai stir-fried noodles'], fndds: ['Pad Thai', 'Pad thai'], serve: 320 },
  { id: 'paella', name: 'Paella', cat: 'pile', f101: 'paella', syn: ['spanish paella with seafood'], fndds: ['Paella', 'Rice with seafood'], serve: 350 },
  { id: 'pancakes', name: 'Pancakes', cat: 'flat', f101: 'pancakes', syn: ['stack of pancakes'], fndds: ['Pancakes, plain', 'Pancake'], h: 3.5, rho: 0.55, serve: 150 },
  // 'Custard' is milk-and-egg set with starch; panna cotta is set cream, at
  // more than twice the energy.
  { id: 'panna-cotta', name: 'Panna cotta', cat: 'dessert', f101: 'panna_cotta', mix: [['Cream, heavy', 0.42], ['Milk, whole', 0.43], ['Sugar, white, granulated or lump', 0.12], ['water', 0.03]], serve: 120 },
  { id: 'peking-duck', name: 'Peking duck', cat: 'meat', f101: 'peking_duck', syn: ['crispy roast duck'], fndds: ['Duck, Peking', 'Duck, roasted', 'Duck'], serve: 180 },
  { id: 'pho', name: 'Pho', cat: 'soup', f101: 'pho', syn: ['vietnamese pho noodle soup'], fndds: ['Pho'], serve: 500 },
  { id: 'pizza', name: 'Pizza', cat: 'flat', f101: 'pizza', syn: ['pizza slice', 'cheese pizza'], fndds: ['Pizza, cheese, from restaurant or fast food, NS as to type of crust', 'Pizza, cheese'], serve: 240 },
  { id: 'pork-chop', name: 'Pork chop', cat: 'meat', f101: 'pork_chop', fndds: ['Pork chop, NS as to cooking method', 'Pork chop'], h: 3, serve: 180 },
  { id: 'poutine', name: 'Poutine', cat: 'snack', f101: 'poutine', syn: ['fries with gravy and cheese curds'], fndds: ['Potato, french fries, with cheese'], h: 5, rho: 0.6, serve: 300 },
  { id: 'prime-rib', name: 'Prime rib', cat: 'meat', f101: 'prime_rib', syn: ['prime rib roast beef'], fndds: ['Beef, roast, roasted', 'Beef roast'], h: 4, serve: 250 },
  { id: 'pulled-pork-sandwich', name: 'Pulled pork sandwich', cat: 'sandwich', f101: 'pulled_pork_sandwich', fndds: ['Pulled pork sandwich', 'Pork sandwich'], serve: 250 },
  { id: 'ramen', name: 'Ramen', cat: 'soup', f101: 'ramen', syn: ['japanese ramen noodle soup'], fndds: ['Ramen'], serve: 500 },
  { id: 'ravioli', name: 'Ravioli', cat: 'pile', f101: 'ravioli', syn: ['ravioli pasta with sauce'], fndds: ['Ravioli, cheese-filled, with tomato sauce', 'Ravioli'], rho: 0.95, serve: 250 },
  { id: 'red-velvet-cake', name: 'Red velvet cake', cat: 'cake', f101: 'red_velvet_cake', fndds: ['Red velvet cake', 'Cake, NFS'], serve: 110 },
  { id: 'risotto', name: 'Risotto', cat: 'pile', f101: 'risotto', fndds: ['Risotto', 'Rice, white, cooked with fat'], rho: 0.95, serve: 280 },
  { id: 'samosa', name: 'Samosa', cat: 'snack', f101: 'samosa', syn: ['indian samosa pastry'], fndds: ['Samosa'], rho: 0.8, serve: 100 },
  { id: 'sashimi', name: 'Sashimi', cat: 'seafood', f101: 'sashimi', syn: ['raw fish sashimi slices'], fndds: ['Sashimi', 'Tuna, raw'], h: 2, serve: 120 },
  { id: 'scallops', name: 'Scallops', cat: 'seafood', f101: 'scallops', syn: ['seared scallops'], fndds: ['Scallops, baked or broiled', 'Scallops'], h: 2.5, serve: 120 },
  { id: 'seaweed-salad', name: 'Seaweed salad', cat: 'salad', f101: 'seaweed_salad', syn: ['wakame seaweed salad'], fndds: ['Seaweed salad', 'Seaweed'], rho: 0.6, h: 3, serve: 100 },
  { id: 'shrimp-and-grits', name: 'Shrimp and grits', cat: 'pile', f101: 'shrimp_and_grits', fndds: ['Grits, with cheese', 'Grits, NFS'], rho: 1.0, serve: 300 },
  { id: 'spaghetti-bolognese', name: 'Spaghetti bolognese', cat: 'pile', f101: 'spaghetti_bolognese', syn: ['spaghetti with meat sauce'], fndds: ['Pasta with tomato-based sauce and meat, restaurant'], serve: 320 },
  { id: 'spaghetti-carbonara', name: 'Spaghetti carbonara', cat: 'pile', f101: 'spaghetti_carbonara', fndds: ['Carbonara', 'Pasta with cream sauce'], serve: 300 },
  { id: 'spring-rolls', name: 'Spring rolls', cat: 'snack', f101: 'spring_rolls', syn: ['fried spring rolls', 'egg rolls'], fndds: ['Egg roll, meatless', 'Spring roll'], rho: 0.7, serve: 120 },
  { id: 'steak', name: 'Steak', cat: 'meat', f101: 'steak', syn: ['grilled beef steak'], fndds: ['Beef steak, grilled', 'Beef steak'], h: 3, serve: 220 },
  { id: 'strawberry-shortcake', name: 'Strawberry shortcake', cat: 'cake', f101: 'strawberry_shortcake', fndds: ['Shortcake with fruit', 'Shortcake'], serve: 140 },
  { id: 'sushi', name: 'Sushi', cat: 'seafood', f101: 'sushi', syn: ['sushi rolls', 'nigiri sushi'], fndds: ['Sushi, NFS', 'Sushi'], h: 3, rho: 0.9, serve: 200 },
  { id: 'tacos', name: 'Tacos', cat: 'sandwich', f101: 'tacos', syn: ['mexican tacos'], fndds: ['Taco or tostada with meat, NS', 'Taco, NFS', 'Taco'], h: 5, serve: 170 },
  { id: 'takoyaki', name: 'Takoyaki', cat: 'snack', f101: 'takoyaki', syn: ['japanese octopus balls'], fndds: ['Octopus', 'Fritter, NFS'], rho: 0.8, serve: 130 },
  { id: 'tiramisu', name: 'Tiramisu', cat: 'dessert', f101: 'tiramisu', fndds: ['Tiramisu'], serve: 130 },
  { id: 'tuna-tartare', name: 'Tuna tartare', cat: 'seafood', f101: 'tuna_tartare', syn: ['raw tuna tartare'], fndds: ['Tuna, raw'], h: 3, serve: 130 },
  { id: 'waffles', name: 'Waffles', cat: 'flat', f101: 'waffles', syn: ['belgian waffle'], fndds: ['Waffle, plain', 'Waffle'], h: 2.5, rho: 0.45, serve: 110 },

  // ============================= Indian =============================
  { id: 'biryani', name: 'Biryani', cat: 'pile', syn: ['chicken biryani', 'hyderabadi dum biryani with saffron rice and fried onions', 'layered spiced basmati rice dish with meat'], fndds: ['Biryani with chicken', 'Biryani with meat'], serve: 300 },
  { id: 'plain-rice', name: 'Steamed rice', cat: 'pile', syn: ['plain white rice', 'boiled rice'], fndds: ['Rice, white, cooked, NS as to fat', 'Rice, white, cooked'], rho: 0.85, serve: 200 },
  { id: 'dosa', name: 'Dosa (plain)', cat: 'flat', syn: ['plain dosa', 'south indian dosa crepe', 'thin crisp rolled rice crepe', 'paper roast dosa'], fndds: ['Dosa, plain'], h: 0.5, rho: 0.5, serve: 110 },
  // FNDDS distinguishes the plain crepe from the filled one, and so must we:
  // a masala dosa is 184 kcal/100 g against the plain crepe's 210, but weighs
  // half as much again because of the potato inside. Reporting one as the
  // other is a 40% error on the commonest South Indian order there is.
  { id: 'masala-dosa', name: 'Masala dosa', cat: 'flat', syn: ['masala dosa with potato filling', 'dosa stuffed with spiced potato masala', 'folded dosa with filling'], fndds: ['Dosa, with filling'], h: 2.2, rho: 0.6, serve: 180 },
  { id: 'idli', name: 'Idli', cat: 'pile', syn: ['south indian steamed idli'], fndds: ['Idli'], h: 2.5, rho: 0.8, serve: 120 },
  { id: 'vada', name: 'Vada', cat: 'snack', syn: ['crispy golden ring shaped south indian medu vada', 'indian fried lentil doughnut'], fndds: ['Vada'], serve: 90 },
  { id: 'chapati', name: 'Chapati / Roti', cat: 'flat', syn: ['roti', 'indian flatbread chapati'], fndds: ['Roti', 'Chapati', 'Tortilla, flour'], h: 0.35, rho: 0.7, serve: 45 },
  { id: 'naan', name: 'Naan', cat: 'flat', syn: ['indian naan bread', 'butter naan with coriander and nigella seeds'], fndds: ['Bread, naan'], h: 0.8, rho: 0.5, serve: 100 },
  { id: 'poori', name: 'Poori', cat: 'flat', syn: ['puri', 'puffed deep fried indian bread', 'golden round puffed poori'], fndds: ['Bread, puri'], h: 3, rho: 0.35, serve: 45 },
  { id: 'paratha', name: 'Paratha', cat: 'flat', syn: ['flaky layered indian paratha flatbread with golden brown spots', 'lachha paratha'], fndds: ['Paratha'], h: 0.6, rho: 0.7, serve: 80 },
  { id: 'dal', name: 'Dal', cat: 'soup', syn: ['indian lentil dal curry', 'dal tadka'], fndds: ['Dal', 'Lentil curry'], serve: 200 },
  { id: 'palak-paneer', name: 'Palak paneer', cat: 'pile', syn: ['indian spinach and cottage cheese curry'], fndds: ['Palak paneer', 'Spinach, creamed'], rho: 1.0, serve: 220 },
  { id: 'paneer-tikka', name: 'Paneer tikka', cat: 'meat', syn: ['grilled indian paneer cubes'], fndds: ['Cheese, paneer'], serve: 150 },
  // Plain 'Chicken curry' is neither buttered nor creamed, and shared its row
  // with chicken-curry exactly. The cream and the extra chicken are the dish.
  { id: 'butter-chicken', name: 'Butter chicken', cat: 'pile', syn: ['murgh makhani', 'indian butter chicken curry'], mix: [['Chicken curry', 0.50], ['Chicken, NS as to part, rotisserie, NS as to skin eaten', 0.26], ['Cream, heavy', 0.20], ['water', 0.04]], rho: 1.0, serve: 250 },
  { id: 'chana-masala', name: 'Chana masala', cat: 'pile', syn: ['chole', 'indian chickpea curry'], fndds: ['Chana masala', 'Chickpeas, from dried'], rho: 0.9, serve: 220 },
  { id: 'rajma', name: 'Rajma', cat: 'pile', syn: ['indian kidney bean curry'], fndds: ['Kidney beans, NFS'], rho: 0.9, serve: 220 },
  // The 'Cauliflower, cooked' fallback dropped both the potato and the oil and
  // priced a 200 g serving at 52 kcal.
  { id: 'aloo-gobi', name: 'Aloo gobi', cat: 'pile', syn: ['indian potato cauliflower curry'], mix: [['Potato, boiled, from fresh, peel not eaten, made with oil', 0.48], ['Cauliflower, fresh, cooked, fat added, NS as to fat type', 0.48], ['Butter, NFS', 0.04]], serve: 200 },
  { id: 'pakora', name: 'Pakora', cat: 'snack', syn: ['indian vegetable fritters'], fndds: ['Pakora'], serve: 100 },
  // Poha is tempered in oil; the plain-rice row left it with 0.28 g fat per 100 g.
  { id: 'poha', name: 'Poha', cat: 'pile', syn: ['indian flattened rice breakfast'], fndds: ['Rice, white, cooked, made with oil'], rho: 0.6, serve: 180 },
  { id: 'upma', name: 'Upma', cat: 'pile', syn: ['south indian semolina upma'], fndds: ['Upma', 'Cream of wheat, cooked'], rho: 0.9, serve: 200 },
  { id: 'pulao', name: 'Pulao', cat: 'pile', syn: ['vegetable pulao rice', 'pilaf'], fndds: ['Rice pilaf', 'Rice with vegetables'], serve: 250 },
  { id: 'tandoori-chicken', name: 'Tandoori chicken', cat: 'meat', syn: ['indian tandoori roasted chicken'], fndds: ['Tandoori chicken', 'Chicken, NS as to part, grilled without sauce, skin not eaten'], serve: 200 },
  { id: 'gulab-jamun', name: 'Gulab jamun', cat: 'dessert', syn: ['dark brown fried gulab jamun balls soaked in sugar syrup'], fndds: ['Gulab jamun', 'Barfi or Burfi, Indian dessert'], rho: 1.1, serve: 100 },
  { id: 'jalebi', name: 'Jalebi', cat: 'dessert', syn: ['indian jalebi sweet spirals'], fndds: ['Jalebi', 'Funnel cake'], rho: 0.7, serve: 70 },
  { id: 'kheer', name: 'Kheer', cat: 'dessert', syn: ['indian rice pudding kheer'], fndds: ['Rice pudding'], rho: 1.05, serve: 150 },
  { id: 'lassi', name: 'Lassi', cat: 'drink', syn: ['indian yogurt lassi drink', 'mango lassi'], fndds: ['Lassi', 'Yogurt, liquid', 'Kefir'], serve: 250 },
  { id: 'chutney', name: 'Chutney (sweet)', cat: 'snack', syn: ['mango chutney', 'sweet tamarind chutney', 'dark brown tamarind dipping sauce'], fndds: ['Chutney'], h: 2, rho: 1.0, serve: 30 },
  // FNDDS has no coconut chutney; its only "Chutney" is a sweet mango relish
  // at 246 kcal/100 g, which is nothing like the white coconut paste served
  // with every dosa. Composed from fresh coconut instead — see `mix` in
  // tools/build-nutrition-db.mjs.
  // The prompts fight clam chowder, not the other chutneys: a small white bowl
  // of pale coarse paste reads as a creamy soup, and on a tight crop chowder
  // won at 0.53 against 0.36 here. So they say thick, coarse and ground, and
  // that it is a dip beside a dosa rather than a bowl of soup.
  { id: 'coconut-chutney', name: 'Coconut chutney', cat: 'snack', syn: ['white coconut chutney', 'south indian coconut chutney', 'thick white coconut chutney paste in a small bowl', 'coarse ground white coconut dip with mustard seeds', 'small bowl of coconut chutney served beside a dosa'], mix: [['Coconut, fresh', 0.45], ['water', 0.55]], h: 2, rho: 1.0, serve: 40 },
  { id: 'green-chutney', name: 'Green chutney', cat: 'snack', syn: ['coriander mint chutney', 'bright green indian chutney dip'], mix: [['Cilantro, raw', 0.5], ['water', 0.5]], h: 2, rho: 1.0, serve: 30 },
  // The savoury South Indian chutneys served beside a dosa. Absent from the
  // vocabulary until now, which meant the orange bowl in a dosa photo had no
  // right answer available: its best chutney candidate was the sweet mango
  // relish above, at 246 kcal/100 g and nothing like what is in the bowl. The
  // classifier reached for hummus and lobster bisque instead, both of which are
  // the right colour and texture and the wrong food.
  //
  // Composed rather than looked up: FNDDS has no South Indian chutney at all.
  // Shares are by mass of the finished paste, tempering oil included, which is
  // most of the energy in all three.
  { id: 'tomato-chutney', name: 'Tomato chutney', cat: 'snack', syn: ['south indian tomato chutney', 'thakkali chutney', 'bowl of thick orange red tomato chutney', 'orange indian chutney served with dosa'], mix: [['Tomatoes, raw', 0.5], ['Onions, raw', 0.12], ['Vegetable oil, NFS', 0.06], ['water', 0.32]], h: 2, rho: 1.0, serve: 35 },
  { id: 'onion-chutney', name: 'Onion chutney', cat: 'snack', syn: ['south indian onion chutney', 'vengaya chutney', 'brown red onion chutney for dosa'], mix: [['Onions, raw', 0.55], ['Vegetable oil, NFS', 0.06], ['Tamarind', 0.03], ['water', 0.36]], h: 2, rho: 1.0, serve: 35 },
  { id: 'peanut-chutney', name: 'Peanut chutney', cat: 'snack', syn: ['groundnut chutney', 'verkadalai chutney', 'thick creamy tan peanut chutney', 'beige brown south indian peanut chutney'], mix: [['Peanuts, roasted, unsalted', 0.35], ['Vegetable oil, NFS', 0.04], ['Tamarind', 0.03], ['water', 0.58]], h: 2, rho: 1.05, serve: 35 },
  { id: 'sambar', name: 'Sambar', cat: 'soup', syn: ['sambhar', 'south indian sambar lentil vegetable stew'], fndds: ['Sambar, vegetable stew'], serve: 150 },
  { id: 'yogurt-plain', name: 'Yogurt (curd)', cat: 'dessert', syn: ['plain yogurt', 'curd', 'dahi', 'bowl of white yogurt'], fndds: ['Yogurt, NFS'], rho: 1.03, h: 2.5, serve: 100 },

  // ============================= East & Southeast Asian =============================
  { id: 'chow-mein', name: 'Chow mein', cat: 'pile', syn: ['chinese stir-fried noodles', 'lo mein'], fndds: ['Chow mein or chop suey, NS as to type of meat, with noodles'], serve: 300 },
  { id: 'sweet-and-sour-pork', name: 'Sweet and sour pork', cat: 'pile', syn: ['chinese sweet and sour pork'], fndds: ['Sweet and sour pork'], rho: 0.95, serve: 250 },
  { id: 'kung-pao-chicken', name: 'Kung pao chicken', cat: 'pile', syn: ['stir fried diced chicken with dried red chilies and peanuts in dark sauce', 'sichuan kung pao chicken'], fndds: ['Kung pao chicken', 'Chicken with vegetables'], rho: 0.95, serve: 250 },
  { id: 'mapo-tofu', name: 'Mapo tofu', cat: 'pile', syn: ['sichuan mapo tofu'], fndds: ['Tofu and vegetables', 'Tofu, NFS'], rho: 1.0, serve: 250 },
  { id: 'congee', name: 'Congee', cat: 'soup', syn: ['rice porridge congee'], fndds: ['Congee', 'Rice porridge'], serve: 400 },
  // Not fried: the egg-roll fallback was pricing a rice-paper roll at 2.4× its energy.
  { id: 'spring-roll-fresh', name: 'Fresh summer rolls', cat: 'snack', syn: ['vietnamese fresh spring rolls', 'rice paper rolls'], fndds: ['rice paper, not fried', 'Summer roll'], rho: 0.85, serve: 130 },
  { id: 'tempura', name: 'Tempura', cat: 'seafood', syn: ['japanese shrimp tempura'], fndds: ['Shrimp, coated, fried', 'Tempura'], rho: 0.6, serve: 150 },
  { id: 'udon', name: 'Udon', cat: 'soup', syn: ['japanese udon noodle soup'], fndds: ['Udon', 'Noodle soup'], serve: 450 },
  { id: 'soba', name: 'Soba', cat: 'pile', syn: ['japanese soba buckwheat noodles'], fndds: ['Soba', 'Noodles, cooked'], serve: 300 },
  { id: 'onigiri', name: 'Onigiri', cat: 'snack', syn: ['japanese rice ball onigiri'], fndds: ['Rice, white, cooked'], rho: 0.95, serve: 110 },
  { id: 'katsu', name: 'Katsu', cat: 'meat', syn: ['japanese breaded pork cutlet tonkatsu', 'chicken katsu'], fndds: ['Pork cutlet, breaded', 'Chicken patty, breaded'], serve: 180 },
  { id: 'curry-rice-jp', name: 'Japanese curry rice', cat: 'pile', syn: ['japanese curry with rice katsu curry'], fndds: ['Curry, NFS', 'Rice with gravy'], serve: 400 },
  // FNDDS has no scallion pancake, and the query 'Pancake' matched *Pancake
  // syrup* — 0 g protein, 0.1 g fat for a pan-fried dough. Composed instead.
  { id: 'spring-onion-pancake', name: 'Scallion pancake', cat: 'flat', syn: ['chinese scallion pancake'], mix: [['Bread, dough, fried', 0.74], ['Onions, raw', 0.14], ['water', 0.12]], h: 1, serve: 100 },
  { id: 'satay', name: 'Satay', cat: 'meat', syn: ['chicken satay skewers with peanut sauce'], fndds: ['Chicken, grilled', 'Kabob'], serve: 140 },
  { id: 'nasi-goreng', name: 'Nasi goreng', cat: 'pile', syn: ['indonesian fried rice nasi goreng'], fndds: ['Fried rice'], serve: 320 },

  // ============================= Western / Middle Eastern staples =============================
  { id: 'burrito', name: 'Burrito', cat: 'sandwich', syn: ['mexican burrito wrap'], fndds: ['Burrito with meat, NS', 'Burrito, NFS', 'Burrito'], serve: 300 },
  { id: 'shawarma', name: 'Shawarma', cat: 'sandwich', syn: ['shawarma wrap', 'doner kebab'], fndds: ['Gyro sandwich', 'Shawarma'], serve: 280 },
  { id: 'kebab', name: 'Kebab', cat: 'meat', syn: ['grilled meat kebab skewers', 'seekh kebab'], fndds: ['Kabob, NFS', 'Kabob'], serve: 180 },
  { id: 'mashed-potatoes', name: 'Mashed potatoes', cat: 'pile', fndds: ['White potato, mashed, NFS', 'Potato, mashed'], rho: 1.0, serve: 210 },
  { id: 'baked-potato', name: 'Baked potato', cat: 'vegetable', fndds: ['White potato, baked, peel eaten', 'Potato, baked'], rho: 0.9, h: 5, serve: 170 },
  { id: 'roast-chicken', name: 'Roast chicken', cat: 'meat', syn: ['roasted chicken', 'rotisserie chicken'], fndds: ['Chicken, NS as to part, rotisserie, NS as to skin eaten'], serve: 200 },
  { id: 'fried-chicken', name: 'Fried chicken', cat: 'meat', syn: ['crispy fried chicken pieces'], fndds: ['Chicken, fried, NS', 'Chicken, coated, fried'], serve: 180 },
  { id: 'meatballs', name: 'Meatballs', cat: 'meat', syn: ['meatballs in tomato sauce'], fndds: ['Meatballs, NS', 'Meatball'], rho: 1.0, serve: 170 },
  { id: 'mac-salad-pasta', name: 'Pasta salad', cat: 'salad', fndds: ['Pasta salad', 'Macaroni salad'], rho: 0.8, serve: 180 },
  { id: 'penne-arrabbiata', name: 'Pasta with tomato sauce', cat: 'pile', syn: ['penne in tomato sauce', 'pasta pomodoro'], fndds: ['Pasta with tomato sauce, meatless', 'Pasta with tomato'], serve: 300 },
  { id: 'pesto-pasta', name: 'Pesto pasta', cat: 'pile', fndds: ['Pasta with pesto', 'Pasta with sauce, NFS'], serve: 280 },
  { id: 'tomato-soup', name: 'Tomato soup', cat: 'soup', fndds: ['Tomato soup, NS', 'Tomato soup'], serve: 350 },
  { id: 'chicken-noodle-soup', name: 'Chicken noodle soup', cat: 'soup', fndds: ['Chicken noodle soup, NS', 'Chicken noodle soup'], serve: 350 },
  { id: 'quiche', name: 'Quiche', cat: 'egg', syn: ['quiche lorraine slice'], fndds: ['Quiche with meat', 'Quiche'], h: 3.5, serve: 170 },
  { id: 'crepes', name: 'Crêpes', cat: 'flat', syn: ['thin french crepes'], fndds: ['Crepe, NS', 'Crepe'], h: 0.4, rho: 0.6, serve: 100 },
  { id: 'sandwich-generic', name: 'Sandwich', cat: 'sandwich', syn: ['sub sandwich', 'deli sandwich'], fndds: ['Sandwich, NFS', 'Turkey sandwich'], serve: 220 },
  { id: 'wrap-generic', name: 'Wrap', cat: 'sandwich', syn: ['chicken wrap', 'veggie wrap'], fndds: ['Wrap sandwich, NFS', 'Chicken wrap'], serve: 230 },
  { id: 'falafel-wrap', name: 'Falafel wrap', cat: 'sandwich', fndds: ['Falafel sandwich', 'Falafel'], serve: 260 },
  { id: 'fish-grilled', name: 'Grilled fish', cat: 'seafood', syn: ['grilled white fish fillet'], fndds: ['Fish, NS as to type, grilled', 'Fish, baked or broiled'], h: 2.5, serve: 160 },
  { id: 'shrimp-grilled', name: 'Grilled shrimp', cat: 'seafood', syn: ['grilled prawns'], fndds: ['Shrimp, grilled', 'Shrimp, cooked'], serve: 120 },

  // ============================= Breakfast =============================
  { id: 'scrambled-eggs', name: 'Scrambled eggs', cat: 'egg', fndds: ['Egg omelet or scrambled egg, NFS', 'scrambled egg'], serve: 120 },
  { id: 'fried-egg', name: 'Fried egg', cat: 'egg', syn: ['sunny side up egg'], fndds: ['Egg, whole, fried'], h: 1.2, serve: 50 },
  { id: 'boiled-egg', name: 'Boiled egg', cat: 'egg', syn: ['hard boiled eggs'], fndds: ['Egg, whole, boiled'], serve: 50 },
  { id: 'bacon', name: 'Bacon', cat: 'meat', syn: ['crispy bacon strips'], fndds: ['Bacon, NS', 'Bacon, cooked'], h: 0.5, serve: 35 },
  { id: 'sausage', name: 'Sausage', cat: 'meat', syn: ['breakfast sausage links'], fndds: ['Sausage, NFS', 'Pork sausage'], serve: 75 },
  { id: 'toast', name: 'Toast', cat: 'flat', syn: ['buttered toast slices'], fndds: ['Bread, toasted', 'Bread, white'], h: 1.5, rho: 0.35, serve: 50 },
  // The 'Avocado' fallback logged the toast without any bread in it.
  { id: 'avocado-toast', name: 'Avocado toast', cat: 'flat', mix: [['Bread, white, toasted', 0.375], ['Avocado, raw', 0.625]], h: 3, rho: 0.6, serve: 130 },
  { id: 'bagel', name: 'Bagel', cat: 'pastry', syn: ['bagel with cream cheese'], fndds: ['Bagel, NFS', 'Bagel'], h: 3, rho: 0.65, serve: 100 },
  { id: 'croissant', name: 'Croissant', cat: 'pastry', fndds: ['Croissant, NFS', 'Croissant'], serve: 60 },
  { id: 'muffin', name: 'Muffin', cat: 'pastry', syn: ['blueberry muffin'], fndds: ['Muffin, NFS', 'Muffin, blueberry'], serve: 110 },
  { id: 'oatmeal', name: 'Oatmeal', cat: 'soup', syn: ['bowl of oatmeal porridge'], fndds: ['Oatmeal, regular or quick, made with water, no added fat', 'Oatmeal, regular or quick, made with milk, no added fat'], serve: 240 },
  { id: 'cereal', name: 'Breakfast cereal', cat: 'soup', syn: ['bowl of cereal with milk', 'cornflakes'], fndds: ['Cereal, NFS', 'Corn flakes'], rho: 0.5, serve: 200 },
  { id: 'granola-yogurt', name: 'Yogurt with granola', cat: 'dessert', syn: ['yogurt parfait'], fndds: ['Yogurt parfait', 'Yogurt, plain'], serve: 220 },
  { id: 'hash-browns', name: 'Hash browns', cat: 'snack', fndds: ['White potato, hash brown', 'hash brown'], h: 2.5, rho: 0.7, serve: 110 },
  { id: 'smoothie', name: 'Smoothie', cat: 'drink', syn: ['fruit smoothie'], fndds: ['Fruit smoothie', 'Smoothie'], serve: 350 },
  { id: 'coffee', name: 'Coffee', cat: 'drink', syn: ['cup of coffee', 'latte', 'cappuccino'], fndds: ['Coffee, NS', 'Coffee, brewed'], serve: 250 },
  { id: 'orange-juice', name: 'Orange juice', cat: 'drink', syn: ['glass of orange juice'], fndds: ['Orange juice, 100%', 'Orange juice'], serve: 250 },

  // ============================= Fruits =============================
  { id: 'apple', name: 'Apple', cat: 'fruit', syn: ['red apple', 'green apple'], fndds: ['Apple, raw'], serve: 180 },
  { id: 'banana', name: 'Banana', cat: 'fruit', fndds: ['Banana, raw'], serve: 120 },
  { id: 'orange', name: 'Orange', cat: 'fruit', fndds: ['Orange, raw'], serve: 130 },
  { id: 'mango', name: 'Mango', cat: 'fruit', syn: ['sliced mango'], fndds: ['Mango, raw'], serve: 165 },
  { id: 'grapes', name: 'Grapes', cat: 'fruit', syn: ['bunch of grapes'], fndds: ['Grapes, raw'], serve: 120 },
  { id: 'watermelon', name: 'Watermelon', cat: 'fruit', syn: ['watermelon slices'], fndds: ['Watermelon, raw'], serve: 280 },
  { id: 'strawberries', name: 'Strawberries', cat: 'fruit', fndds: ['Strawberries, raw'], serve: 120 },
  { id: 'pineapple', name: 'Pineapple', cat: 'fruit', syn: ['pineapple chunks'], fndds: ['Pineapple, raw'], serve: 160 },
  { id: 'papaya', name: 'Papaya', cat: 'fruit', fndds: ['Papaya, raw'], serve: 150 },
  { id: 'pomegranate', name: 'Pomegranate', cat: 'fruit', syn: ['pomegranate seeds'], fndds: ['Pomegranate, raw'], serve: 130 },
  { id: 'kiwi', name: 'Kiwi', cat: 'fruit', syn: ['kiwi fruit slices'], fndds: ['Kiwi fruit, raw', 'Kiwi'], serve: 80 },
  { id: 'avocado', name: 'Avocado', cat: 'fruit', syn: ['avocado halves'], fndds: ['Avocado, raw'], serve: 100 },
  { id: 'blueberries', name: 'Blueberries', cat: 'fruit', fndds: ['Blueberries, raw'], serve: 100 },
  { id: 'fruit-salad', name: 'Fruit salad', cat: 'fruit', syn: ['mixed fruit bowl'], fndds: ['Fruit salad', 'Fruit mixture'], serve: 180 },

  // ============================= Vegetables & sides =============================
  { id: 'green-salad', name: 'Green salad', cat: 'salad', syn: ['garden salad', 'lettuce salad with vegetables'], fndds: ['Lettuce salad with assorted vegetables', 'Green salad'], serve: 120 },
  { id: 'steamed-broccoli', name: 'Broccoli', cat: 'vegetable', syn: ['steamed broccoli florets'], fndds: ['Broccoli, cooked', 'Broccoli, raw'], serve: 110 },
  { id: 'roasted-vegetables', name: 'Roasted vegetables', cat: 'vegetable', fndds: ['Vegetable mixture, cooked', 'Vegetables, NS'], serve: 150 },
  { id: 'corn-on-cob', name: 'Corn on the cob', cat: 'vegetable', syn: ['elote mexican street corn'], fndds: ['Corn, yellow, cooked, on the cob', 'Corn, cooked'], rho: 0.75, h: 4.5, serve: 125 },
  { id: 'grilled-tomato', name: 'Tomatoes', cat: 'vegetable', syn: ['sliced tomatoes'], fndds: ['Tomatoes, raw'], serve: 100 },
  { id: 'cucumber', name: 'Cucumber', cat: 'vegetable', syn: ['cucumber slices'], fndds: ['Cucumber, raw'], serve: 100 },
  { id: 'carrots', name: 'Carrots', cat: 'vegetable', syn: ['carrot sticks'], fndds: ['Carrots, raw'], serve: 80 },
  { id: 'coleslaw', name: 'Coleslaw', cat: 'salad', fndds: ['Coleslaw'], rho: 0.6, serve: 120 },
  { id: 'baked-beans', name: 'Baked beans', cat: 'pile', fndds: ['Baked beans, NFS', 'Baked beans'], rho: 1.0, serve: 180 },
  { id: 'quinoa', name: 'Quinoa', cat: 'pile', syn: ['cooked quinoa bowl'], fndds: ['Quinoa, NS as to fat'], rho: 0.85, serve: 185 },

  // ============================= Desserts & snacks =============================
  { id: 'brownie', name: 'Brownie', cat: 'cake', syn: ['chocolate brownie'], fndds: ['Brownie, NFS', 'Brownie'], h: 3, rho: 0.75, serve: 60 },
  { id: 'cookies', name: 'Cookies', cat: 'dessert', syn: ['chocolate chip cookies'], fndds: ['Cookie, chocolate chip', 'Cookie, NFS'], h: 1.5, rho: 0.65, serve: 45 },
  { id: 'pastry-danish', name: 'Danish pastry', cat: 'pastry', fndds: ['Danish pastry', 'Sweet roll'], serve: 90 },
  // 'Candy, NFS' is the sugar-confection average: 8 g fat where chocolate has 30.
  { id: 'chocolate-bar', name: 'Chocolate', cat: 'dessert', syn: ['chocolate bar pieces'], fndds: ['Chocolate candy', 'Candy, NFS'], h: 1, rho: 1.2, serve: 40 },
  { id: 'popcorn', name: 'Popcorn', cat: 'snack', fndds: ['Popcorn, popped, NS', 'Popcorn'], rho: 0.08, h: 6, serve: 30 },
  { id: 'potato-chips', name: 'Potato chips', cat: 'snack', syn: ['crisps'], fndds: ['Potato chips, NFS', 'Potato chips'], rho: 0.15, h: 4, serve: 40 },
  { id: 'pretzel', name: 'Pretzel', cat: 'snack', syn: ['soft pretzel'], fndds: ['Pretzel, soft', 'Pretzels, hard'], serve: 115 },
  { id: 'pudding', name: 'Pudding', cat: 'dessert', fndds: ['Pudding, NFS', 'Pudding, chocolate'], rho: 1.1, serve: 130 },
  // 'Rice cake' in FNDDS is the puffed snack disc, not a pounded glutinous cake.
  { id: 'mochi', name: 'Mochi', cat: 'dessert', syn: ['japanese mochi rice cake'], fndds: ['Cake made with glutinous rice', 'Rice cake'], rho: 1.1, serve: 60 },
  { id: 'trifle', name: 'Trifle', cat: 'dessert', fndds: ['Trifle', 'Cake with fruit'], serve: 160 },

  // ============================= Mexican =============================
  { id: 'enchiladas', name: 'Enchiladas', cat: 'flat', syn: ['rolled corn tortillas covered in red chili sauce and melted cheese', 'cheese enchiladas', 'enchiladas verdes with green salsa'], fndds: ['Enchilada, NFS', 'Enchilada, chicken'], h: 3, rho: 0.9, serve: 230 },
  { id: 'tamales', name: 'Tamales', cat: 'snack', syn: ['mexican tamales in corn husks', 'tamal'], fndds: ['Tamale, NFS'], rho: 1.0, serve: 130 },
  { id: 'fajitas', name: 'Fajitas', cat: 'pile', syn: ['grilled meat strips with sauteed bell peppers and onions on a sizzling skillet', 'chicken fajitas platter with tortillas'], fndds: ['Fajita, NFS', 'Fajita, chicken'], serve: 250 },
  { id: 'chilaquiles', name: 'Chilaquiles', cat: 'pile', syn: ['fried tortilla chips simmered in salsa topped with crema and crumbled cheese', 'mexican chilaquiles breakfast'], fndds: ['Chilaquiles'], rho: 0.45, serve: 220 },
  { id: 'taquitos', name: 'Taquitos', cat: 'snack', syn: ['crispy rolled fried corn tortilla taquitos topped with lettuce and crema', 'flautas'], fndds: ['Taquito, chicken'], serve: 120 },
  { id: 'refried-beans', name: 'Refried beans', cat: 'pile', syn: ['smooth mashed refried pinto beans in a bowl', 'frijoles refritos with cheese'], fndds: ['Refried beans'], h: 2, rho: 1.05, serve: 130 },
  { id: 'mexican-rice', name: 'Mexican rice', cat: 'pile', syn: ['fluffy orange mexican red rice with peas and carrots', 'spanish rice side dish'], fndds: ['Spanish rice, NS as to fat'], rho: 0.85, serve: 150 },
  { id: 'pozole', name: 'Pozole', cat: 'soup', syn: ['mexican pozole rojo hominy and pork soup topped with radish lettuce and lime'], fndds: ['Soup, pozole'], serve: 350 },
  { id: 'burrito-bowl', name: 'Burrito bowl', cat: 'pile', syn: ['burrito bowl with rice beans and toppings'], fndds: ['Burrito bowl, NFS'], serve: 400 },

  // ============================= Spanish =============================
  { id: 'tortilla-espanola', name: 'Tortilla española', cat: 'egg', syn: ['thick round spanish tortilla de patatas cut into wedges', 'spanish potato omelette'], fndds: ['Egg omelet or scrambled egg, with potatoes and/or onions, NS as to fat'], h: 3.5, serve: 200 },
  { id: 'gazpacho', name: 'Gazpacho', cat: 'soup', syn: ['bowl of cold orange-red tomato gazpacho topped with diced vegetables and a drizzle of olive oil'], fndds: ['Soup, gazpacho'], serve: 250 },
  { id: 'croquetas', name: 'Croquetas', cat: 'snack', syn: ['golden breadcrumbed spanish croquetas cylinders', 'breaded fried ham croquettes'], fndds: ['Ham croquette'], serve: 100 },
  { id: 'patatas-bravas', name: 'Patatas bravas', cat: 'snack', syn: ['spanish patatas bravas with spicy tomato sauce', 'fried potato cubes with aioli'], fndds: ['Potato, home fries, NFS'], serve: 200 },
  { id: 'empanadas', name: 'Empanadas', cat: 'pastry', syn: ['golden baked empanada pastry turnovers with crimped edges', 'fried latin american empanadas'], fndds: ['Empanada, NFS', 'Empanada, beef'], serve: 120 },

  // ============================= Chinese (additional) =============================
  { id: 'wonton-soup', name: 'Wonton soup', cat: 'soup', syn: ['wonton dumplings floating in clear chinese broth with green onions'], fndds: ['Soup, wonton'], serve: 350 },
  { id: 'general-tso-chicken', name: 'General Tso chicken', cat: 'pile', syn: ['orange chicken', 'sesame chicken', 'crispy chinese fried chicken glazed in sweet sauce'], fndds: ['General Tso chicken'], rho: 0.9, serve: 220 },
  { id: 'baozi', name: 'Baozi', cat: 'snack', syn: ['large white fluffy chinese steamed bao buns', 'steamed pork bun in bamboo steamer'], fndds: ['Bao bun'], rho: 0.7, serve: 120 },

  // ============================= Non-food probes (rejection) =============================
  { id: 'nf-person', name: 'a person', nonFood: true, prompts: ['a photo of a person', 'a portrait of a person', 'a selfie'] },
  { id: 'nf-pet', name: 'an animal', nonFood: true, prompts: ['a photo of a dog', 'a photo of a cat', 'a photo of an animal'] },
  { id: 'nf-car', name: 'a vehicle', nonFood: true, prompts: ['a photo of a car', 'a photo of traffic on a street'] },
  { id: 'nf-landscape', name: 'a landscape', nonFood: true, prompts: ['a photo of a landscape', 'a photo of a building', 'a photo of a room interior'] },
  { id: 'nf-screen', name: 'a screen or document', nonFood: true, prompts: ['a screenshot of a computer screen', 'a photo of a document with text', 'a photo of a phone'] },
  { id: 'nf-empty-plate', name: 'an empty plate', nonFood: true, prompts: ['a photo of an empty plate', 'a photo of empty dishes and cutlery on a table'] },
  { id: 'nf-packaging', name: 'food packaging', nonFood: true, prompts: ['a photo of a packaged food product box', 'a photo of a drink bottle label'] },
  { id: 'nf-plant', name: 'a plant', nonFood: true, prompts: ['a photo of a houseplant', 'a photo of flowers in a garden'] },
  // Surfaces and table furniture. These exist because of what happens when the
  // region proposer probes closer to the edge of the frame to reach a cropped
  // side bowl: most of the extra probes land on the table, and with nothing in
  // the non-food set describing a table, the classifier answers with whichever
  // dish the wood or cloth resembles — baklava, panna cotta, apple pie, a
  // grilled cheese sandwich. A crop of a tablecloth needs somewhere to go.
  { id: 'nf-surface', name: 'a table surface', nonFood: true, prompts: ['a photo of a bare wooden table surface', 'a close-up of a marble or stone countertop', 'a photo of an empty tablecloth', 'a photo of a woven placemat', 'a close-up of a slate or granite background'] },
  { id: 'nf-linen', name: 'cloth or paper', nonFood: true, prompts: ['a close-up of a folded cloth napkin', 'a photo of crumpled parchment paper', 'a photo of a paper towel', 'a close-up of plain fabric'] },
  { id: 'nf-cutlery', name: 'cutlery', nonFood: true, prompts: ['a close-up of a metal spoon', 'a photo of a fork and knife on a table', 'a close-up of an empty steel bowl'] },
];

/** Resolve physical priors for an entry (category defaults + overrides). */
export function priorsFor(entry) {
  const [h, rho, serve] = CATEGORY_PRIORS[entry.cat] ?? [2.5, 0.8, 250];
  return {
    heightCm: entry.h ?? h,
    densityGml: entry.rho ?? rho,
    servingG: entry.serve ?? serve,
  };
}

/** CLIP prompt ensemble for an entry. */
export function promptsFor(entry) {
  if (entry.prompts) return entry.prompts; // non-food probes carry explicit prompts
  const names = [entry.name.toLowerCase().replace(/[()⁄éû]/g, (c) => ({ 'é': 'e', 'û': 'u' }[c] ?? '')), ...(entry.syn ?? [])];
  const out = [];
  for (const n of names) {
    out.push(`a photo of ${n}`);
    out.push(`a close-up photo of ${n}, food photography`);
    out.push(`a plate of ${n}`);
  }
  return out;
}
