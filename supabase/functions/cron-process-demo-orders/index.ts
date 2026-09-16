// System-triggered quote refresh + demo order matching.
//
// This scheduled worker processes resting demo orders. Shared quote ingestion
// uses Redis to reuse fresh snapshots and coordinate concurrent requests.
// Deploy with --no-verify-jwt and configure CRON_SECRET plus Redis secrets.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Extend this list if new trading pairs are added to the UI. Keeping it a
// fixed, small watchlist (rather than deriving it from open orders on every
// tick) keeps this function simple and its Binance API usage predictable.
import { createQuoteCache } from "../_shared/quote-cache.mjs";
const quotes = createQuoteCache({ env: (key: string) => Deno.env.get(key) });

const WATCHLIST = ["BTCUSDT", "ETHUSDT"];

Deno.serve(async (request) => {
  try {
    const cronSecret = Deno.env.get("CRON_SECRET");
    if (!cronSecret || request.headers.get("X-Cron-Secret") !== cronSecret) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, serviceKey);

    const results: Record<string, unknown> = {};
    for (const symbol of WATCHLIST) {
      try {
        const snapshot = await quotes.getSnapshot(admin, symbol);

        const { error: processError } = await admin.rpc("process_demo_orders", { p_snapshot_id: snapshot.id });
        if (processError) throw processError;

        results[symbol] = { snapshotId: snapshot.id, ok: true };
      } catch (symbolError) {
        // One symbol failing (e.g. a transient Binance timeout) should not
        // stop the rest of the watchlist from being processed.
        console.error(`cron-process-demo-orders: ${symbol} failed`, symbolError);
        results[symbol] = { ok: false, error: symbolError instanceof Error ? symbolError.message : "unknown error" };
      }
    }

    return Response.json({ results });
  } catch (error) {
    console.error("cron-process-demo-orders: fatal error", error);
    return Response.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
});
