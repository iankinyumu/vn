# Account types

One login can hold typed accounts. Practice (`DEMO`) is built now; Real (`REAL`) is structural readiness only.

| Shared engine behavior | Deliberately separated |
| --- | --- |
| Contract types, policy economics, quote/buy/settle code | Account, wallet, ledger, limits, restrictions, exposure |
| Index branding and configuration | `(index_code, execution_mode)` rows, epochs, seeds, ticks, digits |
| Customer pages and account switcher contract | Funding, credits, custody, cashier, audit classification |

The mode is immutable on the account and carried through contract, tick, epoch, ledger, and exposure keys. `scripts/check-parity.mjs` scans only `*_engine_*.sql` migrations and rejects undeclared behavior branches on execution mode; normal typed key scoping is not a business-mode branch.

Practice begins with virtual USD credits and can reset only under the engine reset rules. It cannot prove funding, custody, reconciliation, payment reliability, load under adversarial real-money use, or seed custody. Real requires an immutable readiness checklist, Owner fresh authentication, external seed custody, reviewed REAL limits, funding and reconciliation, step-up sign-in, a cashier, and conformance evidence before the gate can be enabled. No Real account creation, deposit, withdrawal, conversion, KYC, or Daraja path exists in this build.
