# SmartProfit design rules

This file is the source of truth for how SmartProfit looks. It overrides any
older guidance, including Apple HIG visual styling, glass effects and the blue
accent. Every page, stylesheet and UI script follows it. When a rule here and
some other document disagree, this file wins.

All colours, radii and timings come from `assets/css/tokens.css`. Page CSS reads
tokens and never introduces its own hex values.

## Flat rules

- No shadows (`box-shadow`, `text-shadow`, `drop-shadow`). Separation comes from
  a 1px border or a change of background.
- No blur and no `backdrop-filter`.
- No gradients, including gradient text.
- No card panels. Content sits on the page and is grouped by spacing, headings
  and 1px separators, not by filled or bordered boxes. Floating layers (menus,
  sheets, dialogs, toasts) are solid `--bg-3` with a 1px `--separator` border.
- Corner radius is at most 4px (`--radius-control`). No circles, except where
  the shape itself carries meaning (for example a radio input).
- No decorative motion: no floating particles, glows or shimmering text. Motion
  is limited to short state changes (fades, slides of a sheet), and it goes
  away under `prefers-reduced-motion`.

## Colour

- Neutrals only: near-black and off-white, with greys between, for text,
  backgrounds, borders, links, buttons and charts.
- Green (`--positive`) and red (`--negative`) appear only for buy/sell,
  win/loss and safe/danger states, and nowhere else.
- No blue, purple, teal, orange or any other accent. That includes focus rings,
  selected states, links and chart lines (a neutral line is off-white in dark
  mode and near-black in light mode).
- Green and red never carry meaning alone, because some people can't tell them
  apart. Pair them with `+` and `−` signs or with words such as "Won" and
  "Lost", "Buy" and "Sell".
- Links are the text colour and underlined, so they are told apart by shape.

## Shapes and indicators

- No pills or badges. Status is plain text, for example "Live" or "Won", not a
  rounded or filled tag.
- No dot indicators, pulsing or otherwise.
- Segmented controls and tabs are plain text with an underline on the active
  item.
- The primary button is solid off-white with near-black text in dark mode, and
  near-black with off-white text in light mode, with corners of 4px or less.
  Secondary buttons are a 1px neutral outline.

## Distinctions that used to rely on colour

- **Even and odd digits** carry a text mark: a small "E" or "O" beside the
  digit, with the words "even" and "odd" available to screen readers.
- **Practice and Real accounts** are shown as explicit text, "PRACTICE" or
  "REAL", in the header and on the order ticket. It is never signalled by
  colour alone. This is a safety feature: Real touches real money.
- **Keyboard focus** is a 2px solid outline in the text colour (off-white or
  near-black), offset 2px. Never blue.
- **Selected and current items** use weight, an underline or an edge line in
  the text colour, not a tint.

## Imagery: the plush mascots

The fluffy mascots in `assets/img/mascots/` (WebP, resized from the owner's
originals in `assets/img/`) are illustration, not interface, so they are the
only colour a page may carry outside green and red.

- One mascot per page at most, in a hero or an empty state, where it matches
  the page's job (support, reading, verifying, welcome, "not found").
- Never beside a price, balance, result, payout or buy button, and never on the
  trade page: a mascot must not read as a win or loss signal or make trading
  feel like a game.
- Decorative, so `alt=""` and `aria-hidden="true"` unless it carries meaning;
  explicit `width` and `height`, `loading="lazy"` below the fold,
  `decoding="async"`.
- Transparent on the page background: no frame, circle, card, shadow or glow
  behind it.

## Kept from Apple HIG (non-visual)

These rules still apply. They are about structure and access, not appearance.

- **Type:** two typefaces (`--font-text`, `--font-mono`) and the type ramp in
  `tokens.css`. Nothing smaller than 11px. Prices, balances, digits and results
  use `font-variant-numeric: tabular-nums` so live values don't jitter.
- **Spacing:** the 8px grid with a 4px half step (`--space-*`).
- **Touch targets:** at least 44×44px (`--target`).
- **Focus:** every interactive element has a visible focus ring (see above) and
  is keyboard reachable.
- **Reduced motion:** state changes stay, movement goes, under
  `prefers-reduced-motion: reduce`.
- **Contrast:** WCAG 2.2 AA. Body text at least 4.5:1; field borders and other
  control boundaries at least 3:1. `prefers-contrast: more` strengthens
  secondary text and separators.
- **Layout:** works at 320px width and 200% zoom, in light and dark mode.
- **Live regions:** tick and price updates are throttled for `aria-live` so
  screen readers aren't flooded.
- **Responsibility:** copy and visuals never suggest guaranteed profit or
  urgency. Practice status stays clearly visible.

## Checking for violations

Search the CSS for any hex or `rgb()` colour that isn't grey, green or red,
and for `box-shadow`, `backdrop-filter`, `blur(`, `gradient(`, `border-radius`
values above 4px, and class names containing `pill`, `badge`, `chip` or `dot`.
Anything found is either fixed or listed here with the reason it stays.

Known exceptions, each kept on purpose:

- `var(--shadow-float)` and `var(--shadow-sheet)` are `none`; the names stay so components keep
  their hooks.
- The loading spinner on forgot-password (`.loading-spinner` in `auth.css`) is a circle that
  rotates: the shape and the motion are the loading state.
- The CSS loader fallback (`.sp-loader-art[data-fallback]` in `loader.css`) draws three flat bars
  with `linear-gradient()` used as a solid fill, not a visible gradient.
- The MFA QR code in `admin.html` sits on white so phones can scan it in dark mode.

## Motion

Reviewed with the Emil design-engineering principles. Motion stays only where it marks a state
or explains something, and all of it switches off under `prefers-reduced-motion`:

- Short state changes: 150 to 200ms, ease-out, named properties only (never `transition: all`).
- Press feedback on the buy buttons: `scale(.97)` for 160ms.
- Toasts use a transition with `@starting-style`, so stacked toasts stay interruptible.
- The fund sheet slides in; the digit pointer slides to the latest digit; the rail expands.
- The scroll-driven "How a digit contract settles" section on the home page (GSAP ScrollTrigger,
  `assets/js/settle-story.js`) explains settlement; it is fully readable without the script.
- No hover lifts, glows, floating shapes, pulses or shimmering text.
