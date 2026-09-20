// Authenticated quote ingestion boundary. Deploy with:
// supabase functions deploy refresh-market-quote --no-verify-jwt
// The service-role key is read only in this server runtime, never by the browser.
//
// This endpoint is the first hop of every order, so its failures are the ones a
// customer actually sees. Three rules follow from that:
//   * the CORS preflight is answered before any auth or JSON work, because an
//     OPTIONS request carries no Authorization header;
//   * every failure leaves as { error: { code, message }, request_id } with a
//     stable code, so the browser can translate it instead of guessing;
//   * demo order matching is best-effort here. The scheduled worker owns resting
//     orders, so a slow or failing match must not cost the customer their quote.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { createQuoteCache } from "../_shared/quote-cache.mjs";
import { QuoteError } from "../_shared/errors.mjs";
import { preflightResponse } from "../_shared/cors.mjs";
import { createRequestId, errorResponse, jsonResponse } from "../_shared/http.mjs";

const quotes = createQuoteCache({ env: (key: string) => Deno.env.get(key) });

// Matching is opportunistic on this path; the response is the customer's quote.
const MATCHING_TIMEOUT_MS = 2000;
const SYMBOL_PATTERN = /^[A-Z0-9]{2,20}USDT$/;

Deno.serve(async (request) => {
  const requestId = createRequestId();
  const requestOrigin = request.headers.get("Origin");
  const allowedOrigins = Deno.env.get("ALLOWED_ORIGINS") ?? null;
  const respond = { requestId, requestOrigin, allowedOrigins };

  // Answered before auth and before the body is read.
  if (request.method === "OPTIONS") return preflightResponse(request, allowedOrigins);

  if (request.method !== "POST") {
    return errorResponse({ ...respond, code: "internal", detail: `unsupported method ${request.method}` });
  }

  try {
    const authorization = request.headers.get("Authorization") || "";
    const url = Deno.env.get("SUPABASE_URL")!;
    const publishableKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const caller = createClient(url, publishableKey, { global: { headers: { Authorization: authorization } } });
    const { data: { user }, error: authError } = await caller.auth.getUser();
    if (authError || !user) {
      return errorResponse({ ...respond, code: "unauthorized", detail: authError ?? "no user on the session" });
    }

    await quotes.rateLimit(user.id);

    const payload = await request.json().catch(() => ({}));
    const symbol = typeof payload?.symbol === "string" ? payload.symbol.trim().toUpperCase() : "";
    if (!SYMBOL_PATTERN.test(symbol)) {
      return errorResponse({ ...respond, code: "unsupported_symbol", detail: `symbol=${String(payload?.symbol)}` });
    }

    const admin = createClient(url, serviceKey);

    // A quote is only ingested for a pair the registry marks executable. Without
    // this the browser could mint snapshots for a listed-but-untradable pair and
    // the order would then be rejected later with a confusing message.
    const { data: executableSymbols, error: registryError } = await admin.rpc("list_executable_symbols");
    if (registryError) {
      return errorResponse({ ...respond, code: "registry_unavailable", detail: registryError });
    }
    if (!Array.isArray(executableSymbols) || !executableSymbols.includes(symbol)) {
      return errorResponse({ ...respond, code: "pair_not_available", detail: `registry does not offer ${symbol}` });
    }

    const snapshot = await quotes.getSnapshot(admin, symbol, async (fresh: { id: string }) => {
      // Run once per fresh snapshot, not once per user/cache hit. The scheduled
      // worker covers every tradable pair; this keeps matching prompt for the pair
      // the user is actually trading. A failure here is logged and swallowed: the
      // customer still gets a usable quote and the worker will match the order.
      try {
        const { error } = await admin
          .rpc("process_demo_orders", { p_snapshot_id: fresh.id })
          .abortSignal(AbortSignal.timeout(MATCHING_TIMEOUT_MS));
        if (error) throw error;
      } catch (matchingError) {
        console.warn(`[${requestId}] process_demo_orders skipped for ${symbol}`, matchingError);
      }
    });

    return jsonResponse({ snapshot }, respond);
  } catch (error) {
    const code = error instanceof QuoteError ? error.code : "internal";
    return errorResponse({ ...respond, code, detail: error, headers: { "Retry-After": "3" } });
  }
});
