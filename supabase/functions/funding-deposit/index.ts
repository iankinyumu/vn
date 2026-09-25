// Starts a Daraja STK Push for a deposit quote (docs/REAL_FUNDING_DESIGN.md §9).
//
// JWT verified. The caller supplies only the quote id, their phone number and an
// idempotency key; the KES amount, rate, account and environment come from the
// database. Sandbox only in this release: loadDarajaConfig refuses production.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { preflightResponse } from "../_shared/cors.mjs";
import { createRequestId, errorResponse, jsonResponse } from "../_shared/http.mjs";
import { createDarajaClient, DarajaConfigError, loadDarajaConfig } from "../_shared/daraja.mjs";
import { FundingError, initiateDeposit } from "../_shared/funding-flow.mjs";

Deno.serve(async (request) => {
  const requestId = createRequestId();
  const requestOrigin = request.headers.get("Origin");
  const allowedOrigins = Deno.env.get("ALLOWED_ORIGINS") ?? null;
  const respond = { requestId, requestOrigin, allowedOrigins };

  if (request.method === "OPTIONS") return preflightResponse(request, allowedOrigins);
  if (request.method !== "POST") return errorResponse({ ...respond, code: "validation_failed", detail: `method ${request.method}` });

  let config;
  try {
    config = loadDarajaConfig(Deno.env.toObject());
  } catch (error) {
    const reason = error instanceof DarajaConfigError ? error.code : "config_error";
    return errorResponse({ ...respond, code: "payments_unavailable", detail: `daraja config: ${reason}` });
  }

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: request.headers.get("Authorization") ?? "" } },
    });
    const { data: { user }, error: authError } = await caller.auth.getUser();
    if (authError || !user) return errorResponse({ ...respond, code: "unauthorized", detail: authError ?? "no user" });

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return errorResponse({ ...respond, code: "validation_failed", detail: "body is not JSON" });
    }
    const { quote_id: quoteId, phone, idempotency_key: idempotencyKey } = body ?? {};
    if (typeof quoteId !== "string" || typeof phone !== "string" || typeof idempotencyKey !== "string") {
      return errorResponse({ ...respond, code: "validation_failed", detail: "quote_id, phone and idempotency_key are required" });
    }

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const { data, error } = await admin.rpc(name, args);
      if (error) throw new Error(error.message);
      return data;
    };
    const view = await initiateDeposit({
      rpc, daraja: createDarajaClient({ config }), config, userId: user.id, quoteId, phone, idempotencyKey,
    });
    return jsonResponse(view, respond);
  } catch (error) {
    if (error instanceof FundingError) return errorResponse({ ...respond, code: error.code, detail: error.code });
    return errorResponse({ ...respond, code: "internal", detail: error });
  }
});
