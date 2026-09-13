// Authenticated quote ingestion boundary. Deploy with:
// supabase functions deploy refresh-market-quote --no-verify-jwt
// The service-role key is read only in this server runtime, never by the browser.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type" };

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const authorization = request.headers.get("Authorization") || "";
    const url = Deno.env.get("SUPABASE_URL")!;
    const publishableKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const caller = createClient(url, publishableKey, { global: { headers: { Authorization: authorization } } });
    const { data: { user }, error: authError } = await caller.auth.getUser();
    if (authError || !user) return Response.json({ error: "Unauthorized" }, { status: 401, headers: cors });
    const { symbol } = await request.json();
    if (typeof symbol !== "string" || !/^[A-Z0-9]{2,20}USDT$/.test(symbol)) return Response.json({ error: "Unsupported symbol" }, { status: 400, headers: cors });
    const response = await fetch(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("Market-data provider unavailable");
    const book = await response.json(); const bid = Number(book.bidPrice), ask = Number(book.askPrice);
    if (!(bid > 0 && ask >= bid)) throw new Error("Invalid market-data response");
    const admin = createClient(url, serviceKey);
    const { data: snapshot, error: insertError } = await admin.from("market_snapshots").insert({ source: "BINANCE_BOOK_TICKER", symbol, bid_price: bid, ask_price: ask, depth: [], received_at: new Date().toISOString(), sequence_id: `${book.updateId ?? "book"}-${Date.now()}` }).select("id, bid_price, ask_price, received_at").single();
    if (insertError) throw insertError;
    const { error: processError } = await admin.rpc("process_demo_orders", { p_snapshot_id: snapshot.id });
    if (processError) throw processError;
    return Response.json({ snapshot }, { headers: cors });
  } catch (error) {
    console.error(error);
    return Response.json({ error: error instanceof Error ? error.message : "Quote refresh failed" }, { status: 502, headers: cors });
  }
});
