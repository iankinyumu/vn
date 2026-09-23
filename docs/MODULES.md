# Platform modules

`digit_indices` is enabled for the Practice product. `crypto_spot` is disabled through `public.platform_modules`; its historical browser code, functions, and tests are retained under `modules/crypto-spot` and `supabase/functions/_disabled/crypto-spot`. Its cron job is unscheduled and active customer screens do not load its trade modules.

Re-enabling the archived module requires a reviewed migration to enable its module flag, restore and deploy archived functions, recreate its scheduler, restore server-side configuration, conduct account/data compatibility review, and pass the archival suite. It must not be re-enabled by a browser-only change or a module-table edit in a production console.

`real_accounts` remains disabled. It can be enabled only through `enable_real_accounts` with an Owner’s fresh authentication, the latest published checklist, complete evidence references, and a sufficient audit reason.
