// Public Daraja STK Push callback (docs/REAL_FUNDING_DESIGN.md §5).
//
// Deployed with verify_jwt = false: Daraja cannot send a Supabase JWT. The body
// is an untrusted notification. The per-payment token in the URL only
// correlates it with a payment; the database records it and credits only on the
// server's own STK Push Query of the checkout id returned when the push was
// accepted. Request handling lives in _shared/funding-handlers.mjs.
import { createClient } from "npm:@supabase/supabase-js@2.117.1";
import { createCallbackHandler } from "../_shared/funding-handlers.mjs";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

// Verification runs after the acknowledgement when the runtime supports it.
const defer = (work: Promise<unknown>) => {
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    EdgeRuntime.waitUntil(work);
    return undefined;
  }
  return work;
};

Deno.serve(createCallbackHandler({ getEnv: () => Deno.env.toObject(), createClient, defer }));
