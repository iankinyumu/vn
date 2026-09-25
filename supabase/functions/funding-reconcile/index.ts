// Scheduled funding sweep and daily reconciliation (docs/REAL_FUNDING_DESIGN.md §8).
//
// Deployed with verify_jwt = false and protected by X-Funding-Cron-Secret, which
// must equal the FUNDING_CRON_SECRET function secret. POST {"action":"sweep"}
// queries open payments and expires abandoned ones; POST {"action":"daily",
// "business_date":"YYYY-MM-DD"} writes a reconciliation run (default: yesterday,
// Nairobi time). Sandbox only in this release.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createRequestId, errorResponse, jsonResponse } from "../_shared/http.mjs";
import { createDarajaClient, DarajaConfigError, loadDarajaConfig } from "../_shared/daraja.mjs";
import { reconcileOpenPayments } from "../_shared/funding-flow.mjs";

function sameSecret(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (request) => {
  const requestId = createRequestId();
  const respond = { requestId };
  const secret = Deno.env.get("FUNDING_CRON_SECRET") ?? "";
  if (secret.length < 32 || !sameSecret(request.headers.get("X-Funding-Cron-Secret") ?? "", secret)) {
    return errorResponse({ ...respond, code: "unauthorized", detail: "funding cron secret missing or mismatched" });
  }

  let config;
  try {
    config = loadDarajaConfig(Deno.env.toObject());
  } catch (error) {
    return errorResponse({ ...respond, code: "payments_unavailable", detail: `daraja config: ${error instanceof DarajaConfigError ? error.code : "config_error"}` });
  }
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await admin.rpc(name, args);
    if (error) throw new Error(error.message);
    return data;
  };

  try {
    const body = await request.json().catch(() => ({}));
    if (body?.action === "daily") {
      const yesterday = new Date(Date.now() + 3 * 3600 * 1000 - 86400 * 1000).toISOString().slice(0, 10);
      const day = typeof body.business_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.business_date) ? body.business_date : yesterday;
      const run = await rpc("funding_svc_reconcile", { p_environment: config.environment, p_business_date: day });
      return jsonResponse({ run_id: run.run_id, status: run.status, differences: run.differences.length }, respond);
    }
    const sweep = await reconcileOpenPayments({ rpc, daraja: createDarajaClient({ config }) });
    return jsonResponse(sweep, respond);
  } catch (error) {
    return errorResponse({ ...respond, code: "internal", detail: error });
  }
});
