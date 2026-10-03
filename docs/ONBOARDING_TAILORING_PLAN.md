# Optimization engine plan (2026-10-03)

Owner direction, 2026-10-03: the welcome questions are onboarding only. Their answers never appear anywhere
a customer can see, and customers don't edit them. The site learns the customer from what they do and
adjusts as they progress. The answers are only the starting guess.

## Rules

- **Answers are input only.** They aren't shown on the profile, the dashboard or anywhere else a customer
  can see, and there's no "because you said…" copy. Staff still see them in admin.
- **The engine is invisible.** It keeps an internal level that customers never see: no badges, no
  "level up", nothing shown.
- **It changes guidance and layout only.** It never pushes towards more trades, bigger stakes or longer
  sessions, and never reacts to wins or losses. Break reminders and session limits are the same at every
  level.
- **Customers control things where they are.** Closing the contract explanation, hiding the companion,
  skipping the tour and dismissing Getting started all work in place, and the engine treats each one as
  a signal.
- **Disclosure:** the privacy page says activity is used to adjust guidance. First-party only.
- **No answer and no activity means today's site.**

## Done

1. **Tailoring module** (`assets/js/tailoring.js`, 8570a15). Pages read settings (`guidance`,
   `dashboardLead`, `contracts`), never raw answers. Answer values match their labels (migration
   20261003150000).
2. **Guidance levels** (3c157bd). The "How this contract works" explanation on the ticket, Getting
   started on the dashboard, and the tour run, offered or skipped.
3. **Customer-facing traces removed.** The profile preferences section, the dashboard "Shown because
   you asked… Change this" line and the onboarding "change your answers on your profile" line are gone.
   A test checks that the answers never show.

## Next

### 4. Signals (migration)
- A `customer_signals` table: user, kind, at. A small fixed set of event kinds: `tour_finished`,
  `tour_skipped`, `explain_opened`, `explain_closed`, `getting_started_dismissed`, `guide_opened`.
- A `record_my_signal(kind)` function that only accepts those kinds, with rate limits, readable only by
  its owner and staff.
- Settled contracts (Practice and Real both count) are already on the server and need no new table.

### 5. Engine (migration)
`get_my_experience()` returns the settings `tailoring.js` already uses, computed from:
- **Starting level** from the experience answer: new → new, some → learning, experienced → regular.
- **Level from activity**, which only goes up. Starting thresholds, to be tuned on real usage:
  - learning: 5 or more settled contracts
  - regular: 20 or more settled contracts on 3 or more different days
  - experienced: 100 or more settled contracts, or all three contract types used on 5 or more days
- **Guidance:** new → full, learning → light, regular or experienced → minimal. Closing the explanation
  twice, or skipping the tour, moves guidance one step lower.
- **Contracts:** the most-traded type over the last 30 days, falling back to the onboarding picks.
- **Dashboard lead:** from the goal at first. Once there are 20 or more settled contracts it follows use:
  guides opened recently → guides; otherwise indices.
- Getting started stays until it's dismissed or the level reaches regular.

### 6. Front end
- `tailoring.js` reads `get_my_experience()` (cached for the tab as now) instead of deriving settings
  from the answers.
- The trade page, dashboard and companion record signals through `record_my_signal`.
- Getting started gets a "Dismiss" control.
- One line on the privacy page about activity-based guidance.

### 7. Then the layout work
- Dashboard order from `dashboardLead`.
- The customer's main contract types listed first in the trade page's tabs and on the guides page.
- Results summary and per-contract breakdown (on the history page, linked from the dashboard), checking
  data access first.

Each step ships on its own, passes `npm test` and the DESIGN.md check, and migrations are applied before
the site deploy.
