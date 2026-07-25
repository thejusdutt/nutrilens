# Design system — "steel & turmeric"

NutriLens photographs a plate and measures it. It is an instrument, and the
interface is drawn the way an instrument's face is drawn: cool metal, one warm
mark, every figure sitting on a graduated scale you can read at a glance.

Everything below lives in `app/src/styles.css`, `app/src/readout.js` and
`app/src/icons.js`. Nothing here is decoration for its own sake — each rule
exists because a screenshot showed the alternative failing.

## The idea

The food photograph is the only warm, saturated thing on screen. So the chrome
is deliberately cool: a steel-grey borrowed from the thali the food is served
on. When a photo of a meal lands in that frame, it is the brightest object in
it, which is the correct hierarchy for an app whose subject is the food.

The one warm accent is turmeric, taken from the kitchen rather than from a UI
palette. Errors are chilli. Both come from the same place the food does.

## Colour

Tokens are custom properties on `:root`, re-declared under
`:root[data-theme="dark"]` and under `@media (prefers-color-scheme: dark)` for
users who have never touched the theme switch.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--paper` | `#e6e9ed` | `#0f1216` | The bench everything sits on |
| `--surface` | `#ffffff` | `#171b21` | Cards, inputs, sheets |
| `--ink` | `#12161b` | `#e9edf2` | Body text and figures |
| `--ink-2` | `#5c6874` | `#96a2af` | Labels, units, chart furniture |
| `--ink-3` | `#8b97a4` | `#6c7987` | Placeholders, disabled marks |
| `--rule` / `--rule-strong` | `#d5dbe1` / `#b9c3cd` | `#252c34` / `#333c46` | Hairlines, field borders |
| `--accent` | `#a85b0c` | `#e6a244` | Turmeric: the one warm mark |
| `--alert` | `#a2342a` | `#f2796a` | Chilli: overruns and errors |

Macro colours are food pigments, not a categorical ramp: beetroot
(`--m-protein`), turmeric (`--m-carbs`), olive (`--m-fat`), spinach
(`--m-fiber`), blackcurrant (`--m-sugars`).

Two rules worth stating because breaking them is easy:

- **Charts cannot read custom properties.** They are built as SVG *strings* and
  handed to the DOM, so a `var(--m-carbs)` in a `fill` resolves to nothing. Use
  `cssVar('--m-carbs')` from `ui.js`, which resolves the token at call time and
  therefore follows the theme. Hardcoding the hex works in one theme and one
  theme only.
- **Platform widgets pick their own colour** unless told otherwise.
  `accent-color: var(--accent)` on checkboxes, radios and ranges keeps the
  system blue out of a palette that contains no blue.

Region colours in the plate editor (`plate-ui.js`) carry white text, so every
one of the six clears 4.5:1 against white. The set before them ran as low as
2.09:1.

## Type

Two faces, strict roles, both self-hosted as variable `woff2` and precached by
the service worker so offline never falls back to a system font.

- **Martian Mono** — every figure, unit and eyebrow label. Wide, graduated,
  engineered. `font-variant-numeric: tabular-nums slashed-zero`, so a column of
  calories lines up and a zero is never an O.
- **Instrument Sans** — every word.

The division is absolute: no figure is set in the body face, and no sentence is
set in the mono. If a number appears in a sans run, it is because it is part of
a sentence rather than a measurement.

## The signature: tick scales

`app/src/readout.js` draws the element the rest of the design hangs off. A bar
that only fills left to right tells you how much; a scale with graduations tells
you how much *out of what*, and where the acceptable band sits.

- `tickScale({value, max, low, high, color, height, over})` — one graduated
  track with the target band marked and the current value as a needle. `over`
  switches the fill to `--alert`.
- `stackedScale(parts, max, height)` — the same track carrying several
  components, for a day split by meal or a total split by macro.
- `bandLabel(low, high)` — the band as words, for the text beside it.

They return SVG strings, so they are unit-testable with no DOM
(`app/test/readout.test.js`).

## Icons

`app/src/icons.js` is the only place an icon path lives. One geometry: 24-unit
box, 1.6 stroke, round caps, no fill, `currentColor` throughout — so an icon
inherits the colour of whatever it sits beside and both themes come free.

The app previously used emoji, which meant the operating system drew the chrome
in whatever style it liked: a full-colour cartoon plate next to a grey hairline
label, different on a Pixel and an iPhone, and untouchable by the theme.

Static markup declares icons by name — `<span class="i" data-icon="camera">` —
and `hydrateIcons()` draws them on load. This is load-bearing: `index.html` used
to inline its own copies of the paths, and the two sets promptly drifted, so
four redrawn icons kept rendering their old shapes.

Two icons are filled rather than stroked, and both for the same reason: at
18px, `steps` outlined is a hollow ring above an underscore, which reads as the
ordinal marks in "1º 2º", and `theme` needs a solid half to say "half light,
half dark" at all.

Judge every icon at the size it ships at, magnified — never at 100px. Reading
the path data does not work. Doing this caught four marks that were fine as
drawings and failed as icons: `steps` read as "º₀", `dinner`'s shallow crescent
read as a bitten biscuit, `nutrition`'s three hairlines were indistinguishable
from `barcode`, and `scale` was the scales of justice on a row about body
weight.

## Quality floor

- Every interactive element has a visible focus ring: `2px solid var(--accent)`
  at `2px` offset, on `:focus-visible` only.
- `@media (prefers-reduced-motion: reduce)` collapses every animation and
  transition to `0.01ms`.
- No screen scrolls horizontally at 320px, checked by comparing
  `documentElement.scrollWidth` against `innerWidth` rather than by eye.
- Wide content scrolls inside its own container, never the page body. The
  nutrient table has four columns of names and figures that cannot fit a 320px
  screen; wrapped in `.table-scroll` it scrolls within its card, where before it
  dragged the whole page sideways and silently clipped the `%` column.
- Copy is written, not templated: real sentences, active voice, no emoji as a
  section marker, and no label that says less than the thing it labels
  ("Finish today", not "Complete this entry").
