// Starts a Daraja STK Push for a deposit quote (docs/REAL_FUNDING_DESIGN.md §9).
//
// JWT verified. The caller supplies only the quote id, their phone number and an
// idempotency key; the KES amount, rate, account and environment come from the
// database. Sandbox only in this release: loadDarajaConfig refuses production.
// Request handling lives in _shared/funding-handlers.mjs, which the Node suite
// tests directly.
import { createClient } from "npm:@supabase/supabase-js@2.117.1";
import { createDepositHandler } from "../_shared/funding-handlers.mjs";

Deno.serve(createDepositHandler({ getEnv: () => Deno.env.toObject(), createClient }));
