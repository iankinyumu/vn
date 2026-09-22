// System-triggered quote refresh + demo order matching.
//
// This scheduled worker processes resting demo orders. Shared quote ingestion
// uses Redis when it is available, but Upstash is optional: without it the worker
// falls back to a per-instance cache inside quote-cache.mjs and still matches.
// Deploy with --no-verify-jwt and configure CRON_SECRET.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// The watchlist is never hardcoded here. It is derived from the market registry
// (public.market_symbols.tradable minus paused symbols) so a pair cannot be
// advertised as tradable while this worker silently ignores it.
import { createQuoteCache } from "../_shared/quote-cache.mjs";
import { preflightResponse } from "../_shared/cors.mjs";
import { createRequestId, errorResponse, jsonResponse } from "../_shared/http.mjs";

const quotes = createQuoteCache({ env: (key: string) => Deno.env.get(key) });

async function loadWatchlist(admin: ReturnType<typeof createClient>): Promise<string[]> {
  const { data, error } = await admin.rpc("list_executable_symbols");
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error("market registry returned an unexpected shape");
  return data as string[];
}

Deno.serve(async (request) => {
  const requestId = createRequestId();
  const requestOrigin = request.headers.get("Origin");
  const allowedOrigins = Deno.env.get("ALLOWED_ORIGINS") ?? null;
  const respond = { requestId, requestOrigin, allowedOrigins };

  if (request.method === "OPTIONS") return preflightResponse(request, allowedOrigins);

  try {
    const cronSecret = Deno.env.get("CRON_SECRET");
    if (!cronSecret || request.headers.get("X-Cron-Secret") !== cronSecret) {
      return errorResponse({ ...respond, code: "unauthorized", detail: "cron secret missing or mismatched" });
    }

    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, serviceKey);

    const results: Record<string, unknown> = {};

    let watchlist: string[];
    try {
      watchlist = await loadWatchlist(admin);
    } catch (registryError) {
      return errorResponse({ ...respond, code: "registry_unavailable", detail: registryError });
    }

    if (watchlist.length === 0) {
      // Every tradable pair is paused. That is a valid operational state, not an error.
      return jsonResponse({ results, watchlist }, respond);
    }

    for (const symbol of watchlist) {
      try {
        const snapshot = await quotes.getSnapshot(admin, symbol);

        const { error: processError } = await admin.rpc("process_demo_orders", { p_snapshot_id: snapshot.id });
        if (processError) throw processError;

        results[symbol] = { snapshotId: snapshot.id, ok: true };
      } catch (symbolError) {
        // One symbol failing (e.g. a transient Binance timeout) should not
        // stop the rest of the watchlist from being processed.
        console.error(`[${requestId}] cron-process-demo-orders: ${symbol} failed`, symbolError);
        results[symbol] = { ok: false, error: symbolError instanceof Error ? symbolError.message : "unknown error" };
      }
    }

    return jsonResponse({ results }, respond);
  } catch (error) {
    return errorResponse({ ...respond, code: "internal", detail: error });
  }
});
