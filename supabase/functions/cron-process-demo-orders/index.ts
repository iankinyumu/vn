// System-triggered quote refresh + demo order matching.
//
// Why this exists (separate from refresh-market-quote):
// refresh-market-quote intentionally requires a logged-in user's JWT — it's
// the endpoint the browser calls when a user submits an order, and that
// auth check is what rate-limits/attributes those calls. A cron job has no
// user to authenticate as, so it cannot call that function directly.
//
// This function does the same snapshot-then-fill work, but is authorized by
// a shared secret (CRON_SECRET) instead of a user session, and is meant to
// be invoked only by pg_cron via pg_net on a fixed schedule — never by the
// browser. It processes a fixed watchlist of symbols, so resting LIMIT/
// STOP orders get evaluated even when no user happens to be trading.
//
// Deploy with:
//   supabase functions deploy cron-process-demo-orders --no-verify-jwt
//   supabase secrets set CRON_SECRET=<a long random value>
//
// The migration that schedules this (see
// supabase/migrations/*_schedule_demo_order_matching.sql) stores the same
// secret in Supabase Vault and sends it as the X-Cron-Secret header.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Extend this list if new trading pairs are added to the UI. Keeping it a
// fixed, small watchlist (rather than deriving it from open orders on every
// tick) keeps this function simple and its Binance API usage predictable.
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
        const response = await fetch(
          `https://api.binance.com/api/v3/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`,
          { signal: AbortSignal.timeout(5000) },
        );
        if (!response.ok) throw new Error("Market-data provider unavailable");
        const book = await response.json();
        const bid = Number(book.bidPrice), ask = Number(book.askPrice);
        if (!(bid > 0 && ask >= bid)) throw new Error("Invalid market-data response");

        const { data: snapshot, error: insertError } = await admin
          .from("market_snapshots")
          .insert({
            source: "BINANCE_BOOK_TICKER",
            symbol,
            bid_price: bid,
            ask_price: ask,
            depth: [],
            received_at: new Date().toISOString(),
            sequence_id: `${book.updateId ?? "cron"}-${Date.now()}`,
          })
          .select("id")
          .single();
        if (insertError) throw insertError;

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
