# Platform modules

`digit_indices` is enabled for the Practice product. `crypto_spot` is disabled through `public.platform_modules`; its historical browser code, functions, and tests are retained under `modules/crypto-spot` and `supabase/functions/_disabled/crypto-spot`.

Re-enabling the archived module requires a reviewed migration to enable its module flag, restoration and deployment of its archived functions, re-creation of its scheduler, restoration of its server-side configuration, account backfill, and a passing archival test suite. It must not be re-enabled by a browser-only change.

`real_accounts` remains disabled. It can be enabled only through `enable_real_accounts` with an Owner’s fresh authentication, the latest published checklist, complete evidence references, and a sufficient audit reason.
