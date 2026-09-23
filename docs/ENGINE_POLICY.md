# Engine policy

Policy versions are immutable and affect new contracts only. Each contract records its policy version, payout, multiplier, and winning-digit count; a later publication cannot rewrite an accepted contract.

| Field | Version 1 | Rationale |
| --- | --- | --- |
| House margin | 3.5% | Common Practice and future Real economics |
| Margin overrides | empty | Bounded 0.5%–15% per contract type |
| Tick bounds | 1–10 | Limits time exposure |
| Settlement delay | 30 seconds | Late tick voids and refunds the contract |
| Feed lag | 10 seconds | Blocks purchases against stale ticks |
| Minimum profit ratio | 1% | Rejects economically meaningless offers |
| Tick retention | 30 days | Retains revealed, unreferenced audit data |
| DEMO stake | USD 1.00–1,000.00 | Caps virtual per-contract risk |
| DEMO open contracts | 20 | Limits concurrent customer exposure |
| DEMO buy rate | 30/minute | Limits abusive bursts |
| DEMO tick liability | USD 100,000.00 | Caps correlated exposure |

Payout is numeric cent-floor rounding of `stake × (1 − margin) × 10 / winning_digits`. Flooring can make effective margin slightly higher at small stakes; this intentionally favors the house. Publication validates the complete DEMO limits payload, enabled types, legal barriers, and minimum-stake profitability. No REAL limits are seeded or published in this build.
