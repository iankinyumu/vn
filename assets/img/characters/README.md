# 2D plush characters

Flat vector versions of the plush mascots in `assets/img/*.png`, drawn by
`scripts/generate-characters.mjs` (edit the script, then run
`node scripts/generate-characters.mjs`; do not hand-edit the SVGs).

The trade page companion (`assets/js/trade-companion.js`) uses them; nothing
else does yet. The current mascot and avatar images (`assets/img/mascots`,
`assets/img/avatars`) are unchanged.

- `<id>.svg`: animated. Blinks, breathes, and sways its accessory. Each
  character starts at a different moment, so a page never moves in unison.
- `<id>-still.svg`: the same drawing with no animation, for dense grids
  (pickers, lists) and for reduced motion.
- `<id>-asleep.svg`: eyes closed and a quiet "z z", no animation. The trade
  companion shows it while the price feed is not live.
- `trio.svg`: forest headphones, ivory heart and green cloud with beret, side
  by side (animated).

Ids match `assets/js/avatars.js`.

## Reduced motion

Browsers do not pass the reduced-motion setting into SVGs loaded as images, so
the page has to choose the file:

```html
<picture>
  <source srcset="../assets/img/characters/peach-whistle-still.svg" media="(prefers-reduced-motion: reduce)">
  <img src="../assets/img/characters/peach-whistle.svg" alt="" width="120" height="120" decoding="async">
</picture>
```

Use them as illustration under the DESIGN.md imagery rule: never beside a
price, balance, result or buy button. The trade companion is the one
documented exception (see DESIGN.md, "The trade companion").
