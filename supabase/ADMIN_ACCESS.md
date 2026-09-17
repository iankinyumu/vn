# Staff access foundation — Phase 1

Implementation date: 17 September 2026. The migration and static entry page are implemented locally. They have **not** been deployed, and no owner has been created in the configured project.

The implementation order follows sections 23 and 28 of `ADMIN_DASHBOARD_FOUNDATION.md`. Phase 2 must extend these operations; it must not create another role or ticket store.

## Current delivery and verification

| Item | State |
|---|---|
| Separate authoritative staff roles and centralized capability resolution | Implemented; PostgreSQL permission tests pass |
| Private verified-owner bootstrap | Implemented; denial, identity and one-time tests pass |
| Owner-only role changes, versions, idempotency, last-owner safeguards | Implemented; serialized outcomes tested locally |
| MFA gate and 10-minute TOTP freshness for role changes | Implemented; PostgreSQL and UI tests pass |
| Transactional, protected audit records and owner audit reader | Implemented; rollback and mutation-denial tests pass |
| Static staff entry, authenticator enrollment/verification, session clearing | Implemented; automated UI tests pass |
| Support workflow: additive schema, scoped inbox, replies, internal notes, lifecycle, unread tracking | Implemented; PostgreSQL and sandbox tests pass |
| Dual SupportWorkspace UI: staff inbox in admin.html and customer conversation in support.html | Implemented; JSDOM sandbox workflow tests pass |
| Customer administration & trading restrictions: account search, balance inspection, DB-level restriction enforcement | Implemented; PostgreSQL and UI tests pass |
| Demo trading oversight: read-only order monitoring, fill inspection, customer filtering | Implemented; PostgreSQL and UI tests pass |
| Market quote health & instrument pause/resume controls: freshness checks, symbol pause overrides | Implemented; PostgreSQL and UI tests pass |
| Owner staff management UI: role changes, activation status, optimistic concurrency versioning | Implemented; PostgreSQL and UI tests pass |
| Platform overview dashboard: real-time operational KPIs, ticket counts, market status | Implemented; PostgreSQL and UI tests pass |
| Real simultaneous transactions on ordinary PostgreSQL | Pending staging verification; PGlite is single-connection |
| Rendered desktop/mobile and real Supabase MFA round trip | Pending; no connected browser available in this session |
| Initial owner, retention policy, staged rollout | Pending operator/project-owner decisions |

## Files and local verification

- Migrations: `migrations/20260917100000_staff_access_foundation.sql`, `migrations/20260917110000_support_workflow.sql`.
- Pages: `../pages/admin.html`, `../pages/support.html`, `../pages/contact.html`.
- Scripts/styles: `../assets/js/admin.js`, `../assets/js/support-ui.js`, `../assets/js/support-workspace.js`, `../assets/js/customer-support.js`, `../assets/css/admin.css`, `../assets/css/support.css`.
- Backend tests: `../tests/admin-permissions.test.mjs`, `../tests/support-workflow.test.mjs`.
- Frontend session/workflow tests: `../tests/admin-ui.test.mjs`, `../tests/sandbox-pages.test.mjs`.

From the repository root:

```powershell
npm.cmd ci --ignore-scripts
npm.cmd test
```

PGlite executes the real migration and RPCs as PostgreSQL, using minimal test-only Auth tables and JWT helpers. Tests switch database roles to exercise actual SQL permissions rather than mocking authorization. Test identities never reach Supabase. Existing contact and caching tests run in the same suite.

This does not substitute for Supabase gateway/JWT verification, Auth enrollment tests, or multi-connection locking tests. Test claims are supplied by the harness; production claims must come from Supabase's verified request context.

## Access contract

All application role assignments live in `public.staff_roles`, independently of editable profiles and Auth user metadata. There is one role per user. Customers have no staff row. Revoked rows remain with `active = false`, preserving grant history.

Browser roles have no direct table access. Even the service role is not granted direct access to the new role and audit tables. Application writes run through narrow security-definer functions with an empty search path. Infrastructure database administrators remain a separate trust boundary.

| Operation | Authority | Result |
|---|---|---|
| `get_staff_context()` | Authenticated user with current active staff row | Identity, role, version, capabilities, required MFA step |
| `change_staff_role(user, role, active, expected_version, reason, request_id)` | Current owner, AAL2, TOTP verified in the last 600 seconds | Confirmed role/active/version, with transactional audit |
| `list_admin_audit(before_time, before_id)` | Current owner at AAL2 | At most 50 newest-first events; paired time/ID cursor |
| `admin_private.bootstrap_owner(user, verified_email, reason)` | Trusted SQL operator; not exposed through the public API | Initial owner and operator audit event in one transaction |

The context may return the caller's own role before MFA so the page can guide verification; capabilities remain empty and protected data remains inaccessible until AAL2. This limited context is not an authorization token for subsequent operations.

Capability names for the future support operations are defined centrally but grant no new ticket-table access. Only `staff.enter`, `staff.manage`, and `audit.read` have operations in Phase 1. No customer-directory, financial, market, content, or security capabilities are implicitly granted.

Administrators do not receive the full staff-access audit. Their support operational history is delivered with Phase 2's ticket-scoped events.

## MFA and session behavior

Staff entry requires the verified JWT's `aal` claim to be `aal2`. Sensitive role changes additionally require a `totp` entry in `amr` whose timestamp is no more than **600 seconds** old and is not in the future. Token refresh, password authentication and empty/missing authentication-method history cannot substitute for TOTP verification.

The page uses Supabase's existing Auth client, `mfa.listFactors`, `mfa.enroll` and `mfa.challengeAndVerify`. Enrollment is an explicit button action. The setup key is shown only in the current page, then erased when the access context changes; it is not logged or saved in application storage. Existing verified authenticators can be selected. Never remove a verified factor just to resolve a UI error.

If enrollment is abandoned, Supabase may retain an unverified factor. An operator should inspect and remove only abandoned **unverified** factors through Auth's supported management tools if enrollment reaches its factor limit. Do not weaken the MFA gate to work around enrollment failures.

The page clears staff data on every authentication event, on page exit, and before access rechecks. Old response generations cannot restore content. A read-only recheck runs every 60 seconds after successful entry; every protected backend request independently checks the current staff row. Revocation denies new requests immediately after commit, even while the old browser token remains valid. Without realtime, already displayed content is removed on the next recheck or denied operation. There are no background mutation retries.

Sources: [Supabase MFA](https://supabase.com/docs/guides/auth/auth-mfa), [JWT claims](https://supabase.com/docs/guides/auth/jwt-fields), [TOTP enrollment](https://supabase.com/docs/reference/javascript/auth-mfa-enroll), [challenge and verify](https://supabase.com/docs/reference/javascript/auth-mfa-challengeandverify).

## Initial owner setup

1. Choose a staging project and apply the additive migration through the existing migration process. `apply-migration.cjs` takes its database connection only from `TRADING_DB_URL`; do not put database credentials in browser configuration or source control.
2. The project owner supplies the intended **existing Auth user UUID and verified email**. Compare them in the trusted Auth administration interface and independently confirm the intended recipient. A support-form contact address is not identity evidence.
3. In a trusted database-operator session, execute this parameterized statement. Supply values using your SQL client's parameter mechanism; the strings below are not deployable identities:

```sql
select admin_private.bootstrap_owner(
    $1::uuid, -- verified existing Auth user ID
    $2::text, -- independently checked verified Auth email
    $3::text  -- reason, including operator identity and change/ticket reference
);
```

4. Verify exactly one `staff.bootstrap` event and the matching active owner row. The bootstrap rejects missing/unverified/mismatched identities and any repeat after initialization. It cannot be used to recover or appoint later owners.
5. Open `/pages/admin.html`, sign in with that account and complete authenticator enrollment/verification. Confirm AAL1 cannot read the audit and AAL2 can.
6. Establish a second approved owner through the owner-authorized `change_staff_role` operation using a recently verified session. No service key is needed or accepted as a replacement for the acting owner's identity.

Do not automatically select the first registrant or a local configured email. This work has not performed bootstrap.

## Role changes and owner safety

Inputs must include an existing verified target, an allowed role, an explicit active flag, a 3–500 character trimmed reason, the expected version and a unique request UUID. A new assignment uses expected version `0`; changes use the currently recorded version. Successful changes increment the version. Up to 30 successful changes per actor per rolling hour are allowed; exact retries do not consume another slot.

Retry an uncertain outcome with the exact same request ID and inputs. A reused ID with different inputs or a stale expected version yields `conflict`. Retry acknowledgments describe the original committed operation; they do not claim to be the newest role state after unrelated later changes.

An owner cannot alter their own role, including self-promotion or self-revocation. A second owner must perform that change. Removal/demotion of the final owner is also checked explicitly. Auth deletion of a staff user is restricted by the role foreign key so it cannot silently remove the remaining ownership path.

All role writers serialize on `admin_private.access_lock`, then recheck the caller's authority. The lock uses a row update so stale repeatable-read transactions fail with serialization errors. Future assignment revocation, invitations and role membership writers must use this same lock order. Application users cannot bypass the lock with direct table writes.

When Phase 2 introduces assignments, extend role revocation/downgrade to unassign affected work with ticket history in the same transaction. Do not ship Phase 2 while role changes can leave assignments with ineligible staff.

## Error mapping

`unauthenticated`, `forbidden`, `mfa_required`, `reauthentication_required`, `validation_failed`, `verified_identity_required`, `conflict`, `rate_limited`, `self_role_change_forbidden`, `last_owner_required` and `bootstrap_already_completed` are stable operation messages. Database permission errors on denied direct access are expected. The UI never renders raw SQL messages or stack traces. A network error is shown as unavailable, not as revocation or an empty result.

## Staging verification gate

Use distinct verified owner A, owner B, administrator, agent and customer accounts. Check their actual Supabase sessions and direct HTTP/RPC calls as well as the page. Verify desktop/mobile layout, keyboard focus, loading, sign-out, permission denial, network failure, MFA setup/failure/success, audit empty/error/pagination and literal rendering of submitted text.

For the real PostgreSQL owner race, use two independent SQL connections in a disposable test database, or staged authenticated RPC requests:

1. Owner A begins a transaction and demotes B but does not commit yet.
2. Owner B concurrently attempts to demote A using B's previously valid session. Verify B waits at the shared writer lock.
3. Commit A. Verify B fails authorization after acquiring the lock and cannot demote A.
4. Repeat with A rolling back; B may proceed, but one active owner must remain.
5. Repeat at repeatable-read isolation; stale snapshots must produce a serialization failure, never a zero-owner commit.
6. Verify audit failure rolls back the role change. Verify denied role/table/audit writes for anonymous, customer, agent, administrator and owner requests.

Capture evidence before marking the gate complete. Local single-connection tests cover resulting authorization states and rollback, not true simultaneous transactions.

## Recovery and rollback

If another owner still has MFA access, use the normal audited role workflow. If every owner loses access, a trusted infrastructure operator must independently verify a recovery identity and document the incident/change reference. Prefer supported Supabase Auth factor recovery for an existing owner; record the operator action and require new MFA enrollment before staff use.

If replacing an inaccessible owner is unavoidable, use a reviewed SQL transaction as the database operator: update the same access-lock row first, verify the replacement's confirmed Auth identity, insert/reactivate the replacement owner, and append an `actor_type = 'operator'` audit event with `action = 'staff.owner_recovery'`, target, correlation UUID, safe before/after summaries and an operator/incident reason. Keep at least one active owner throughout; do not delete prior assignments or audit evidence. Have a second operator review the identity and resulting state. This is an exceptional infrastructure procedure, not a public recovery endpoint.

Before production rollout, the project owner must choose support/audit retention and any anonymization policy. No automatic retention deletion has been introduced. Audit rows do not cascade with Auth account removal or store messages, email addresses, tokens or MFA setup keys.

To roll back exposure, withdraw the new page and revoke the three public RPC execute grants from `authenticated` in an operator change. Retain the role and audit tables. Do not delete operational history or modify existing support/trading policies. Record the reason and operator change reference. Restore grants only after verifying the foundation again.

## Next section

After the Phase 1 verification gate, implement section 28 items 5–8 first: additive ticket schema, one-source original-message projection/backfill, scoped read operations, atomic assignment/reply/note/status/read-marker operations and permission tests. Then build the inbox and customer conversation UI against those working operations.
