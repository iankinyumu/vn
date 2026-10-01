# VN2 (SmartProfit): Claude instructions

## UI/UX standard: DESIGN.md is the source of truth

For any work that touches UI, styling, layout, components, interaction, motion, or user-facing copy (`pages/*.html`, `assets/css/`, `assets/js/shell.js` and other UI scripts):

1. Read `DESIGN.md` first and follow it. It defines the look: flat, neutral greys only, green and red solely for buy/sell, win/loss and safe/danger, no accent colours, pills, badges, dots, shadows, blur, gradients or card panels, and radius at most 4px. Where anything else (including the `apple-hig` skill) disagrees on appearance, `DESIGN.md` wins.
2. The `apple-hig` skill (web mode, via its `web-translation.md`) still applies to the non-visual rules only: type, spacing, touch targets, focus, reduced motion, accessibility and component states. Every component needs default, hover, pressed, focus-visible, disabled, loading, empty, and error states.
3. Before calling UI work done, run the check at the end of `DESIGN.md`: search the CSS for any colour that isn't grey, green or red, and for shadows, blur, gradients, radius above 4px, and pill, badge, chip or dot classes.

### Project-specific rules

- **Stack:** static multi-page site with vanilla JS and plain CSS. No framework, bundler, or CSS preprocessor. Keep it that way.
- **Shared shell:** header, navigation, and footer for customer pages come from `assets/js/shell.js` (styles in `assets/css/app-shell.css`). Change navigation there, not per page.
- **Design tokens:** colors, type scale, spacing, radii, and motion timings live in `assets/css/tokens.css` as custom properties named by role (`--label`, `--label-2`, `--bg`, `--accent`, …). `--accent` is neutral (the text colour). Add new values as tokens, not hard-coded hex or px scattered through page CSS.
- **Trading UI:** digits, prices, balances, and results use tabular numerals (`font-variant-numeric: tabular-nums`) so live values don't jitter. Win/loss must never be signaled by color alone; pair green and red with `+`/`−` signs or words. Even and odd digits carry an "E" or "O" mark.
- **Account mode:** Practice and Real are shown as explicit text ("PRACTICE" or "REAL") in the header and on the order ticket, never by colour alone.
- **Responsibility:** copy and visuals must never suggest guaranteed profit or urgency ("Win big!", countdown pressure, flashing gains). Keep Practice/virtual status clearly visible.
- **Accessibility floor:** WCAG 2.2 AA. 44×44px touch targets, a visible 2px neutral focus outline, works at 320px width and 200% zoom, keyboard reachable, `prefers-reduced-motion` respected, live tick/price regions throttled for `aria-live` so screen readers aren't flooded.
- **Testing:** after UI changes, run `npm test` (browser tests run on jsdom) and check pages in both light and dark mode. Keep all `data-*` attributes and test-checked text.
