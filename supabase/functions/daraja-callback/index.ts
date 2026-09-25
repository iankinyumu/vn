// Public Daraja STK Push callback (docs/REAL_FUNDING_DESIGN.md §5).
//
// Deployed with verify_jwt = false: Daraja cannot send a Supabase JWT. The body
// is an untrusted notification. It is bound to one payment only by the
// per-payment token in the URL, recorded, and then checked with the server's own
// STK Push Query; the database credits only on that query result. The response
// is always the documented acknowledgement unless the record itself failed, so a
// forger learns nothing. Nothing from the body is logged.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CALLBACK_ACK, createDarajaClient, loadDarajaConfig } from "../_shared/daraja.mjs";
import { handleCallback } from "../_shared/funding-flow.mjs";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

// Without a valid provider config the callback is still recorded; the status
// query waits for the funding-reconcile sweep.
const unavailableDaraja = {
  environment: "SANDBOX",
  stkPush: () => { throw new Error("daraja_unavailable"); },
  stkQuery: async () => ({ outcome: "ERROR", resultCode: null, resultDesc: "daraja_config_unavailable" }),
};

Deno.serve(async (request) => {
  if (request.method !== "POST") return Response.json(CALLBACK_ACK);
  const token = new URL(request.url).searchParams.get("t");
  if (Number(request.headers.get("Content-Length") ?? 0) > 16 * 1024) return Response.json(CALLBACK_ACK);
  const bodyText = await request.text();

  let daraja;
  try {
    daraja = createDarajaClient({ config: loadDarajaConfig(Deno.env.toObject()) });
  } catch {
    daraja = unavailableDaraja;
  }
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await admin.rpc(name, args);
    if (error) throw new Error(error.message);
    return data;
  };
  const defer = (work: Promise<unknown>) => {
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) { EdgeRuntime.waitUntil(work); return undefined; }
    return work;
  };
  const result = await handleCallback({ rpc, daraja, bodyText, token, defer });
  return Response.json(result.body, { status: result.status });
});
