# Onboarding tailoring plan (2026-10-03)

The welcome questions tell customers we will "set the platform up around you". Most of that is not built yet.
This plan covers what each answer should change, and in what order to build it.

## What the answers do today

| Answer | Values | What it changes now |
|---|---|---|
| Goal | `learn`, `short_term`, `grow`, `strategy` | Nothing. Staff can read it in admin, and customers can't change it on the profile. |
| Experience | `new`, `some`, `experienced` | Only the trade companion tour: `experienced` skips it, everyone else gets it once (`trade-companion.js`). `new` and `some` behave the same. |
| Interests | `evenodd`, `matches`, `overunder` | The trade page opens on the first chosen contract family (`trade.js`). |
| Start with | `trade`, `guides`, `dashboard` | Where the customer lands when they finish onboarding. Used once. |

Skipping, or leaving a question blank, keeps today's site exactly as it is. That stays the default.

## Ground rules

- **Tailoring changes order and emphasis, never access.** Every page, contract and section can still be reached by everyone. Nothing gets hidden behind an answer.
- **One place reads the answers.** Add `assets/js/tailoring.js`. It reads `window.smartProfitOnboarding.answers()` once and turns the answers into a small settings object, e.g. `{ guidance: 'full' | 'light' | 'minimal', dashboardLead: 'guides' | 'indices' | 'results' | 'breakdown', contracts: [...] }`. Pages use that object and never read raw answers themselves. This also means the label-versus-value mismatch can't come back.
- **Changes are presentational.** Tailoring reorders and shows or collapses existing DOM. No trading, pricing or balance logic depends on it.
- **No profit framing.** For example, `grow` must not lead to "earn more" copy. It only puts the customer's own results first. The neutral risk line stays on every variant.
- **Easy to undo.** Every tailored page carries a quiet text link: "Tailored to your answers · Change". It goes to the profile preferences.

## Work items

### 1. Tailoring module (foundation)
- Create `assets/js/tailoring.js`, loaded after `auth.js` on customer pages through the shell.
- Set `data-guidance` and `data-dashboard-lead` on `<html>`, so CSS and page scripts can react without async waits. Cache the result in sessionStorage alongside the onboarding cache, and clear it whenever `markOnboardingComplete` runs.
- Move the companion tour's `experience === 'experienced'` check onto `guidance`.

### 2. Guidance level (from Experience)
- **`new` → full:** the tour runs. The order ticket shows a one-line explanation under each contract and under payout. The dashboard shows a "Getting started" block with links to the three guides (settlement, payouts, fairness).
- **`some` → light:** the tour is offered, not started: a single "Take the tour" text button. Ticket explanations are collapsed behind an info icon. No getting-started block.
- **`experienced` → minimal:** no tour prompt. Ticket explanations are collapsed. No getting-started block.
- Right now `new` and `some` behave identically. This item is what makes them differ.

### 3. Dashboard lead (from Goal)
The dashboard today has Account, then Index overview. The goal picks one block to put directly under Account:
- **`learn`:** "Getting started" guides block, with the next unread guide first.
- **`short_term`:** Index overview first, with a direct "Trade" link on each index.
- **`grow`:** a results summary: settled trades, win/loss count and net result, signed with `+`/`−` and drawn from existing history.
- **`strategy`:** a results breakdown by contract type and index, linking to trade history filtered to that contract.

The results summary and breakdown are new presentational blocks over data the history page already loads. Check the RPC before building. If they need a new read RPC, that becomes a separate backend change.

### 4. Contracts of interest (from Interests)
- Already done: the trade page opens on the first chosen family.
- Add: the trade page's family tabs list the chosen families first. The guides index puts guides for those contracts first. The getting-started block names the chosen contracts.

### 5. Start with (one-off)
No change. It stays a one-time landing choice.

### 6. Profile preferences
- Add **Goal** to the profile preferences form (`pages/profile.html`, `profile-preferences.js`). Step 1 promises "You can change your answers later on your profile", and today goal can't be changed there.
- The profile labels for experience ("New to it", "Tried it a bit", "Trade regularly") differ from onboarding's ("Beginner", "Intermediate", "Experienced"). Use the onboarding labels in both places.
- Change the save message from "The trade page will follow your new preferences" to "The site will follow your new preferences".

### 7. Tests
- Unit test `tailoring.js`: answers in, settings out, including empty answers mapping to today's defaults.
- Browser tests: one dashboard run per goal, checking which block comes first. One trade run per guidance level, checking tour and explanation state. A test that skipping onboarding leaves the dashboard unchanged.
- Keep the existing onboarding and companion tests passing.

## Order

1. Tailoring module and profile Goal field (items 1 and 6). **Done 2026-10-03:** `assets/js/tailoring.js` loaded on every signed-in page; trade page and tour read it; Goal is on the profile.
2. Guidance levels (item 2).
3. Dashboard lead for `learn` and `short_term`, which reorder existing blocks (item 3, first half).
4. Results summary and breakdown for `grow` and `strategy` (item 3, second half). Check data access first.
5. Contract ordering on tabs and guides (item 4).

Each step ships on its own and passes `npm test` plus the DESIGN.md check before moving on.

## Open questions for the owner

- Should "Getting started" disappear by itself after the customer's first few settled trades, or stay until it's dismissed?
- For `grow` and `strategy`, is a per-contract results breakdown wanted on the dashboard, or only on the history page?
