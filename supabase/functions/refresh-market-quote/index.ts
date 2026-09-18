// Authenticated quote ingestion boundary. Deploy with:
// supabase functions deploy refresh-market-quote --no-verify-jwt
// The service-role key is read only in this server runtime, never by the browser.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { createQuoteCache, QuoteError } from "../_shared/quote-cache.mjs";
const quotes = createQuoteCache({ env: (key: string) => Deno.env.get(key) });

const cors = { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type" };

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405, headers: cors });
  try {
    const authorization = request.headers.get("Authorization") || "";
    const url = Deno.env.get("SUPABASE_URL")!;
    const publishableKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const caller = createClient(url, publishableKey, { global: { headers: { Authorization: authorization } } });
    const { data: { user }, error: authError } = await caller.auth.getUser();
    if (authError || !user) return Response.json({ error: "Unauthorized" }, { status: 401, headers: cors });
    await quotes.rateLimit(user.id);
    const { symbol } = await request.json();
    if (typeof symbol !== "string" || !/^[A-Z0-9]{2,20}USDT$/.test(symbol)) return Response.json({ error: "Unsupported symbol" }, { status: 400, headers: cors });
    const admin = createClient(url, serviceKey);
    // A quote is only ingested for a pair the registry marks executable. Without
    // this the browser could mint snapshots for a listed-but-untradable pair and
    // the order would then be rejected later with a confusing message.
    const { data: executableSymbols, error: registryError } = await admin.rpc("list_executable_symbols");
    if (registryError) throw new QuoteError("Market registry is unavailable.");
    if (!Array.isArray(executableSymbols) || !executableSymbols.includes(symbol)) {
      return Response.json({ error: "This pair is not available for demo trading." }, { status: 400, headers: cors });
    }
    const snapshot = await quotes.getSnapshot(admin, symbol, async (fresh: { id: string }) => {
      // Run once per fresh snapshot, not once per user/cache hit. The scheduled
      // worker covers every tradable pair; this keeps matching prompt for the
      // pair the user is actually trading.
      const { error } = await admin.rpc('process_demo_orders', { p_snapshot_id: fresh.id }).abortSignal(AbortSignal.timeout(2000));
      if (error) throw new QuoteError('Order updates are temporarily unavailable.');
    });
    return Response.json({ snapshot }, { headers: cors });
  } catch (error) {
    console.error(error);
    return Response.json({ error: error instanceof QuoteError ? error.message : "Quote refresh failed" }, { status: error instanceof QuoteError ? error.status : 502, headers: { ...cors, "Retry-After": "3" } });
  }
});
