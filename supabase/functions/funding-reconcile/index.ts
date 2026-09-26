// Scheduled funding sweep and daily reconciliation (docs/REAL_FUNDING_DESIGN.md §8).
//
// Deployed with verify_jwt = false and protected by X-Funding-Cron-Secret, which
// must equal the FUNDING_CRON_SECRET function secret. POST {"action":"sweep"}
// queries open payments and expires abandoned ones; POST {"action":"daily",
// "business_date":"YYYY-MM-DD"} writes a reconciliation run (default: yesterday,
// Nairobi time). Sandbox only in this release. Request handling lives in
// _shared/funding-handlers.mjs.
import { createClient } from "npm:@supabase/supabase-js@2.117.1";
import { createReconcileHandler } from "../_shared/funding-handlers.mjs";

Deno.serve(createReconcileHandler({ getEnv: () => Deno.env.toObject(), createClient }));
