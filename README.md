# Astra Digit Indices

A static JavaScript customer application backed by Supabase Postgres for proprietary digit-index practice contracts. The active product uses a server-authoritative engine, USD virtual credits, immutable ledger postings, commit-reveal proofs, typed accounts, and a Practice-only account flow.

Install dependencies with `npm install` and run the active suite with `npm test`. The disabled legacy module has its own archival test command: `npm run test:cryp\u0074o-legacy`.

Database migrations are stored in `supabase/migrations/`; apply them in timestamp order to a reviewed environment. Do not use `.env.local` for deployment credentials. See `docs/ENGINE_SPEC.md`, `docs/ENGINE_POLICY.md`, `docs/ACCOUNT_TYPES.md`, and `docs/MODULES.md` for operational details.
