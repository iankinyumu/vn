# Admin Dashboard Foundation and Implementation Guide

**Project:** SmartProfitBinary  
**Document type:** Product requirements, permission model, and engineering implementation guide  
**Status:** Implementation complete locally; Phases 1, 2, 3, and 4 fully implemented and verified against PostgreSQL and UI tests (54/54 tests passing); Staging/live Supabase deployment pending operator.

**Created:** 16 September 2026  
**Updated:** 18 September 2026  
**Location:** Project root; this is a local planning document, not a database migration.

### Implementation progress — 18 September 2026

Work follows the dependency order in sections 23 and 28, one phase at a time. Requirements in sections 1–22 define the acceptance boundaries rather than independent screen-building tasks.

- **Phase 1 / backlog items 1–4 (COMPLETED LOCALLY):** Staff roles, centralized permissions, private owner bootstrap, protected role changes, MFA enforcement, transactional audits, the staff entry page and permission/session tests are implemented and verified (`tests/admin-permissions.test.mjs`, `tests/admin-ui.test.mjs`).
- **Phase 2 / backlog items 5–11 (COMPLETED LOCALLY):** Additive ticket schema (`20260917110000_support_workflow.sql`), scoped inbox, public messages, private internal notes, status lifecycle, read markers, dual-purpose `SupportWorkspace` UI component, customer support page (`pages/support.html`), and end-to-end sandbox tests (`tests/support-workflow.test.mjs`, `tests/sandbox-pages.test.mjs`).
- **Phase 3 & 4 (COMPLETED LOCALLY):** Customer administration (scoped account search, detail inspection, authoritative trading restrictions and restoration via `account_restrictions`), demo trading oversight (read-only order and execution inspection), market quote health and instrument pause/resume controls (`market_symbol_controls`), owner staff management UI, and platform overview summary (`20260918120000_customer_and_operational_admin.sql`, `assets/js/admin-operations.js`, `tests/admin-operational.test.mjs`). All 54 suite tests pass.
- **Staging / Deployment gate pending:** Real multi-connection PostgreSQL race verification, live Supabase deployment and MFA round trip, remote owner bootstrap.

See [staff-access implementation and operator instructions](supabase/ADMIN_ACCESS.md) for file locations, test commands, contracts, bootstrap/recovery procedures and the remaining checks.

### Reading map

| To understand | Read |
|---|---|
| The complete platform scope | Sections 29–32 |
| Initial roles and security foundation | Sections 5–7 and 16 |
| Specialist staff responsibilities | Section 30 |
| The first support implementation | Sections 9–15 |
| Customer and demo-trading controls | Sections 17–18 and 29 |
| Implementation order | Sections 23, 28, and 33 |
| Backend resources for the broader modules | Section 36 |
| Release requirements and decisions | Sections 24–27, 34, and 37 |

## 1. Purpose and how to use this document

This document defines what the admin dashboard will do, who may use each function, how its frontend and backend should work together, and what must be verified before release.

It is the foundation for implementation. It should prevent disconnected screens, placeholder statistics, inconsistent permissions, and administrative actions that appear successful without changing authoritative data.

The dashboard is a **platform administration workspace**, not only a support inbox. Its full scope includes customer accounts, support, demo trading, market data, content publishing, security, operations, reporting, communications, staff access, and controlled platform settings. Sections 29–35 define these broader responsibilities and their implementation boundaries.

The first implementation milestone remains **secure staff access plus a complete support workflow** because that provides a useful, testable first release. It is a delivery sequence, not a limit on what the final admin dashboard will handle. Later modules must use the same permission and audit foundation.

The requirements below describe planned behavior unless explicitly identified as existing. Creating this document does not create roles, deploy endpoints, change accounts, or enable administrative access.

Use this document to:

1. Agree on the product scope and permission boundaries.
2. Break implementation into reviewable development tasks.
3. Design database changes and API contracts before building dependent screens.
4. Implement the frontend against working backend behavior.
5. Test the complete customer and staff workflow.
6. Review readiness against the acceptance criteria.

When an implementation decision changes, update the relevant requirement here and its tests. Do not let the UI, backend, and guide describe different behavior.

## 2. Existing foundation

The repository already has customer-facing pages, authentication, demo trading data, and a contact support form. The admin dashboard must build on those capabilities instead of creating a second customer identity system or separate ticket store.

### 2.1 Existing support behavior

- Customers sign in to submit support requests.
- Requests are persisted in the backend and associated with the authenticated customer.
- Customers receive readable references such as `SP-1001`.
- Internal UUIDs remain identifiers for backend operations; customers use the readable reference.
- Customers can view their request status.
- Submission validation, retry deduplication, and a per-account submission limit already exist.
- Customer reads are isolated to their own requests.
- There is not yet a customer/staff conversation thread, assignment workflow, or staff dashboard.
- Attachments and automated support email delivery are not implemented.

### 2.2 Existing trading boundary

Trading functionality is currently for DEMO accounts. The admin dashboard must preserve that boundary.

Administrative access must not introduce real-money execution, deposit approval, withdrawal processing, or a way to edit ledger balances directly. Those capabilities would require a separately designed and approved project.

### 2.3 Relationship to the existing backend

The application currently uses Supabase for authentication and database services. That is an implementation context, not the purpose or location of this plan. The product requirements apply regardless of the underlying backend technology.

Where this document mentions database policies, server functions, or authentication services, implementation should use the existing architecture unless a specific need justifies a change. Do not introduce an additional backend framework merely to build an admin dashboard.

## 3. Product principles

### 3.1 Real actions and real data

Every displayed count, ticket, customer, status, and operational indicator must come from an authoritative source. An empty system displays an empty state. A failed query displays an error. Neither condition should produce invented data.

### 3.2 Backend-enforced permissions

The backend decides whether an action is allowed. Hiding links or buttons improves navigation but is not authorization. Direct API requests must be subject to exactly the same permissions.

### 3.3 Minimum necessary access

Staff receive only the information and capabilities required for their work. A support agent does not need unrestricted customer browsing or access to authentication secrets.

### 3.4 Accountable changes

Every privileged state change records who performed it, what changed, which resource it affected, and when it happened. Sensitive actions also require a reason.

### 3.5 Clear customer language

Show readable ticket references, understandable statuses, and concise instructions. Never expose raw database errors, internal role codes, UUIDs, or implementation details as the normal user experience.

### 3.6 Honest outcomes

The UI reports success only after the server confirms the operation. Saving a reply and sending an email are separate outcomes. A failed notification must not make a successfully saved reply appear lost.

### 3.7 Revocation takes effect promptly

Current staff permissions must be checked for each protected operation. A stale browser session or cached role must not preserve access after a role is removed.

An operation already authorized and committed before revocation is not retroactively undone. New requests after revocation commits must be denied. Particularly sensitive operations should recheck authorization inside their transaction.

## 4. Scope and delivery boundaries

### 4.1 First release

The first release includes:

- Protected admin entry and staff session handling.
- Customer, support agent, administrator, and owner permission boundaries.
- A controlled initial owner setup.
- A support inbox with search, filtering, assignment, and pagination.
- Ticket details with customer messages, staff replies, internal notes, and activity history.
- A customer conversation view connected to the existing contact page.
- Enforced ticket status transitions.
- In-application unread indicators.
- Audit records for privileged changes.
- Permission and workflow tests.

### 4.2 Later releases

- Customer search and account inspection beyond ticket context.
- Trading restrictions and restoration.
- Read-only demo trading oversight.
- Operational metrics and service health.
- Staff invitations and role management screens.
- Email notifications with durable delivery and retries.
- Content editing and publication for blog posts, FAQs, and approved site sections.
- Instrument availability and market-data health management.
- Security investigation and explicitly authorized response actions.
- Background-job monitoring and safe retries.
- Service announcements and incident communications.
- Aggregate reporting with defined metrics and access scope.
- Specialist roles and capability-based access management.
- Allowlisted platform settings and cross-module audit review.

See section 29 for module requirements and section 33 for the full delivery roadmap. The earlier support phases describe the first working release, not the complete platform scope.

### 4.3 Explicitly excluded from the initial project

- Real-money trading operations.
- Manual editing of balances, fills, or ledger history.
- Staff access to customer passwords or authentication secrets.
- Customer impersonation or a “log in as customer” action.
- Attachments without a designed storage and access-control workflow.
- Public live chat, chatbots, and automated ticket resolution.
- Bulk customer exports.
- Deleting customer accounts from the admin UI.
- A general-purpose settings editor capable of changing arbitrary backend values.

These exclusions should not be represented by fake working buttons. Omit unavailable features or label them clearly in development documentation.

## 5. Roles and responsibilities

### 5.1 Customer

A customer is a regular authenticated account holder. Customer capability is the default; it does not require a staff role assignment.

Customers can create requests, read their own conversations, reply to their own tickets, and request reopening according to the ticket lifecycle. They cannot read internal notes or inspect other accounts.

### 5.2 Support agent

A support agent handles tickets assigned to them.

Agents can read assigned requests, inspect limited customer context needed for those requests, reply publicly, add internal notes, and perform permitted status transitions. Agents cannot browse the full customer directory, assign themselves arbitrary tickets, or change another agent's assignment.

Administrators and owners manage the shared intake queue and assignment in the first release. This avoids giving every agent unrestricted access to all incoming customer information.

### 5.3 Administrator

An administrator manages daily support operations and, in later phases, account restrictions and read-only trading oversight.

Administrators can view the support queue, assign and reassign tickets, handle escalations, and inspect operational records. They cannot appoint staff, change their own privileges, remove owners, or alter ledger history.

### 5.4 Owner

An owner has administrator capabilities plus staff-access management and explicitly approved sensitive configuration controls.

Owner is an application role, not an instruction to distribute database-owner credentials. An owner still uses protected application operations and remains subject to audit requirements.

Owner access is not unrestricted permission to rewrite immutable data. Financial record integrity applies to every application role.

### 5.5 Assignment model

Use one active staff role per user initially: support agent, administrator, or owner. As specialist modules are delivered, extend this with the scoped roles defined in section 30. Do not automatically give administrators every new specialist permission. A staff member may still have their own customer account behavior, but staff authorization is stored separately from customer-editable profile fields.

Do not allow clients to select staff roles during registration. Do not trust a role submitted in a form, query string, local storage, or editable profile metadata.

## 6. Permission matrix

“Assigned” means the ticket is currently assigned to the acting support agent. “Own” means the resource belongs to the authenticated customer.

| Capability | Customer | Support agent | Administrator | Owner |
|---|---|---|---|---|
| Enter staff dashboard | No | Yes | Yes | Yes |
| Create customer support request | Own | Own customer context | Own customer context | Own customer context |
| Read customer ticket conversation | Own | Assigned | All tickets | All tickets |
| Send public staff reply | No | Assigned | All tickets | All tickets |
| Add/read internal notes | No | Assigned | All tickets | All tickets |
| Read shared intake queue | No | No | Yes | Yes |
| Assign/reassign tickets | No | No | Yes | Yes |
| Update ticket handling status | Limited customer actions | Assigned | All tickets | All tickets |
| Reopen a resolved ticket | Own, under lifecycle rules | Assigned | Yes | Yes |
| Read limited ticket customer context | Own | Assigned ticket only | Yes | Yes |
| Search full customer directory | No | No | Later phase | Later phase |
| Restrict/restore trading | No | No | Later phase | Later phase |
| Disable/restore account sign-in | No | No | No | Later phase, separate protected action |
| Inspect demo trading records | Own existing access | No | Later phase, read-only | Later phase, read-only |
| Invite staff or change staff roles | No | No | No | Yes, once staff management is delivered |
| View support activity history | Own public history only | Assigned | All tickets | All tickets |
| View full administrative audit log | No | No | Operational subset | Yes |
| Edit/delete audit records | No | No | No | No |
| Edit ledger history or balances directly | No | No | No | No |

Implement these capabilities explicitly. Avoid scattered string comparisons that gradually create inconsistent permission rules.

## 7. Authentication and administrative access

### 7.1 Entry flow

1. A person opens the admin page.
2. The page checks whether there is an authenticated session.
3. If there is no session, show a sign-in action with a safe return path.
4. If there is a session, request the current staff access context from the backend.
5. If the account has no active staff role, display an access-denied state.
6. If the staff session needs MFA verification, show that step before loading protected data.
7. Load navigation and data appropriate to the verified capabilities.

Do not briefly render protected content while permissions are loading. Do not interpret a network failure as proof that the user is a guest or has been banned.

### 7.2 Staff access context

The backend should return a small access context containing the user identifier, active role, allowed capabilities, and any required authentication step. Return only the information needed by the UI.

Frontend capability data controls presentation. The backend must independently verify permission for later reads and writes.

### 7.3 MFA and reauthentication

MFA is a release requirement for staff access. Role changes, staff removal, and account sign-in restrictions also require a recently verified session.

The exact freshness window must be chosen during the permission-foundation phase, documented, and tested. Until that mechanism is implemented, do not expose sensitive administrative controls with a weaker substitute.

**Phase 1 implementation decision:** Staff access requires AAL2. Role changes require a TOTP verification timestamp within the last 600 seconds; token refresh does not extend that window. This rule is enforced by the backend and covered by permission tests. Initial enrollment uses the existing Supabase authenticator flow; exceptional recovery remains an audited operator procedure described in `supabase/ADMIN_ACCESS.md`.

### 7.4 Session changes

On sign-out, user switching, or staff revocation:

- Clear staff data from the screen and memory caches.
- Stop active subscriptions and protected polling.
- Disable pending editors and new actions.
- Ignore late responses associated with the old identity or access context.
- Show the appropriate signed-out or access-denied state.

A failed request must not automatically retry a privileged mutation under a different user's session.

### 7.5 First owner bootstrap

The first owner must be established through a controlled server-side setup process using a verified existing user identity.

The process must verify that the intended account exists, prevent anonymous execution, create the initial role assignment, and record a bootstrap audit event. There must be no public “become owner” endpoint and no rule that makes the first person to register an owner.

Subsequent owner changes go through the normal protected owner workflow. Deployment documentation must describe how the initial identity is selected and verified; never embed personal credentials in a migration.

### 7.6 Last-owner protection

The backend must reject any operation that would leave no active owner. Concurrent demotion and removal operations must be serialized so two owners cannot simultaneously remove the last remaining ownership path.

Recovery from lost owner access must be a documented operator procedure outside the ordinary customer UI. Recovery must leave an audit trail.

## 8. Frontend information architecture

The initial application can use the existing static HTML, CSS, and JavaScript approach. A framework migration is not a prerequisite.

Suggested page organization:

| Page or view | Purpose | Initial availability |
|---|---|---|
| Admin entry/overview | Staff access check and useful support summary | First release |
| Support inbox | Search, filter, and select requests | First release |
| Ticket detail | Conversation, notes, assignment, status | First release |
| Customer ticket detail | Read/reply to own conversation | First release |
| Customers | Search and inspect accounts | Later phase |
| Trading oversight | Read-only demo activity | Later phase |
| Staff | Invitations, roles, revocation | Later phase |
| Audit | Administrative event review | Basic first release; expanded later |

Suggested implementation files are `pages/admin.html`, `assets/js/admin.js`, and `assets/css/admin.css`, with additional modules when responsibilities become large enough to warrant separation. Exact filenames may change without changing the requirements.

### 8.1 Navigation

Show only navigation items the current role can use. Keep the staff area visually recognizable and provide a clear route back to the customer application.

The header must show the actual authenticated staff identity and role. Do not show sign-in prompts to an authenticated staff member or display an administrator label before checking the backend.

### 8.2 UI states required for every data view

- Loading.
- Successful result.
- Empty result.
- Filter produces no matches.
- Network or backend error with a retry action.
- Permission denied.
- Session expired or signed out.
- Mutation in progress.
- Mutation confirmed.
- Conflict caused by another staff member's update.

Empty and error states must be distinct. A broken query must not look like an inbox with no requests.

### 8.3 Accessibility and responsive behavior

All controls need meaningful labels, keyboard access, visible focus, and sufficient contrast. Status must be expressed in text, not color alone. Announce important updates without moving focus unexpectedly.

At smaller widths, convert the inbox and ticket layout into a usable single-column view. Avoid requiring horizontal scrolling to read a customer's message or reach reply actions.

## 9. Support inbox

### 9.1 List contents

Each ticket row should show:

- Readable reference, such as `SP-1001`.
- Topic in plain language.
- Customer display name or an appropriate fallback.
- Current status.
- Assigned agent, where the viewer has assignment visibility.
- Last activity date/time.
- Unread indicator relative to the viewing staff member.

Do not show the full message, phone number, technical identifiers, and every timestamp in the list. Those belong in the detail view where needed.

### 9.2 Search and filters

Support exact ticket-reference search and topic/status filtering. Administrators and owners can additionally filter by assigned agent and unassigned tickets.

Customer identity search must follow the viewer's scope. An agent must not discover an unassigned customer's existence through search results or counts.

Default ordering should prioritize recent activity. If unread-first ordering is introduced, make the ordering understandable and stable.

### 9.3 Pagination

Use bounded queries and a stable pagination strategy. A page size is an implementation limit, not a total ticket count or a limit on how many requests a customer may have.

The customer interface should say “Your requests” and offer “Load more” when there are more results. Staff can see a result count when the backend can provide it accurately and efficiently.

Do not silently hide older requests with no way to reach them. Prefer cursor pagination based on the ordering timestamp and a unique tie-breaker.

## 10. Ticket detail and conversation

### 10.1 Header and context

Show the ticket reference, topic, status, assigned agent where appropriate, and creation date. Show customer contact information in a separate context area available only to authorized staff.

The contact email entered on a support form is a contact preference, not proof of identity. Ownership is determined by the authenticated account linked to the ticket.

### 10.2 Public conversation

The conversation contains the original customer message, later customer replies, and staff replies intended for the customer.

Each message displays the author type, appropriate display name, timestamp, and body. Staff messages should identify a support representative without exposing personal staff contact information.

For the first release, use plain text rendering with safe whitespace handling. Do not render arbitrary submitted HTML. Messages must remain readable on narrow screens and must not create executable content.

### 10.3 Staff reply composer

- Clearly label the action as a reply to the customer.
- Validate nonempty trimmed content and an enforced size limit.
- Disable duplicate submission while a reply is pending.
- Use an idempotency key so a retry does not create two replies.
- Preserve the draft when saving fails.
- Clear the draft only after the server confirms persistence.
- Display the confirmed saved message in the conversation.

If the session or permission changes while a draft is open, prevent submission under the old access assumptions. Do not persist sensitive drafts in shared browser storage by default.

### 10.4 Internal notes

Internal notes belong in a visibly separate staff-only composer and timeline treatment. Use an explicit “Add internal note” action, distinct from “Send reply.”

Customers must never receive notes through API responses, public message queries, notification payloads, search snippets, or exports. Frontend hiding is insufficient.

Use separate storage for notes in the first release to reduce the risk of accidentally exposing a visibility flag through a broad message query.

### 10.5 Edits and deletion

Treat sent messages and internal notes as immutable in the initial release. Correct errors with a follow-up message or note. Do not add unreviewed deletion or editing controls that destroy the conversation history.

Any future redaction workflow must preserve an auditable record of who performed the redaction and why, while appropriately handling the removed sensitive material.

## 11. Ticket lifecycle

### 11.1 Status definitions

| Stored status | Display label | Meaning |
|---|---|---|
| `open` | Received | The request is saved and awaiting handling. |
| `in_progress` | In progress | Support is actively handling the request. |
| `waiting_for_customer` | Waiting for you | Support needs information from the customer. Staff see “Waiting for customer.” |
| `resolved` | Resolved | Support believes the issue has been addressed. |
| `closed` | Closed | The conversation is closed to further replies. |

The existing schema does not yet include `waiting_for_customer`; implementation requires a deliberate migration and updated display mappings.

### 11.2 Permitted transitions

| From | To | Actor and requirement |
|---|---|---|
| Received | In progress | Assigned agent, administrator, or owner |
| Received/In progress | Waiting for customer | Authorized staff; save a public reply explaining what is needed in the same operation |
| Waiting for customer | In progress | Customer reply automatically advances status, or authorized staff resumes work |
| Received/In progress/Waiting | Resolved | Authorized staff; provide a public resolution explanation |
| Resolved | In progress | Customer reopens with an explanation, or authorized staff reopens with a reason |
| Resolved | Closed | Administrator or owner, with reason |
| Closed | In progress | Administrator or owner, with reason |

A customer cannot set a ticket to resolved or closed in the initial release. Customers cannot reply to a closed ticket until an authorized administrator reopens it; the UI should explain that they can submit a new request referencing the closed ticket.

There is no automatic closure timer in the first release. Introduce one only after deciding the customer notice, reopening policy, and operational requirements.

### 11.3 Backend enforcement

Validate transitions on the server. Record status history and audit data in the same transaction as the status change. Use a version or equivalent concurrency check to prevent one staff member from silently overwriting another's work.

Assignment and status are separate concepts. Assigning a ticket does not automatically claim the customer has received a reply or that the issue is being resolved.

## 12. Assignment and escalation

Administrators and owners may assign tickets only to active, eligible staff. An assignment records the previous assignee, new assignee, actor, timestamp, and optional operational note.

Agents cannot continue reading a ticket after it is reassigned away from them unless their role independently grants access. In-flight responses must be discarded when the client learns its access context has changed; new requests must be denied by the backend immediately after the assignment change commits.

An agent escalates through an internal note and an explicit escalation action or flag. Escalation must be visible to administrators. It must not silently grant the agent administrator privileges.

When staff access is revoked, open assignments must be returned to the unassigned queue or transferred through a controlled operation. The first release should use unassignment, preserving assignment history.

## 13. Customer-side support experience

The existing contact page remains the customer's starting point. Extend it with a ticket detail/conversation view rather than requiring customers to enter the admin application.

The customer should be able to:

1. Submit a request and receive a readable reference.
2. Select a request from their list.
3. Read the original message and public replies.
4. See the current status and whether support needs a response.
5. Reply while the ticket is open for conversation.
6. Reopen a resolved request with an explanation.
7. Find older requests through pagination.

Sign-in state must remain consistent across navigation, account guidance, the form, and request history. Do not leave static “please log in” text visible after authentication succeeds.

A staff member's internal note, assignment reasoning, or restricted audit metadata must not appear in the customer view.

## 14. Proposed backend data model

These are conceptual resources. Final SQL and field types belong to implementation migrations, not this planning document.

| Resource | Purpose | Important fields or constraints |
|---|---|---|
| Staff roles | Authoritative current staff access | User ID, role, active state, granted by, timestamps; one active role per user initially, explicit memberships when specialist roles ship |
| Existing support requests | Ticket identity and current state | Existing UUID and ticket number, customer ID, topic, status, assignee, version, last activity |
| Support messages | Public conversation | Ticket ID, author ID/type, body, creation time, idempotency key |
| Support internal notes | Staff-only notes | Ticket ID, staff author, body, timestamp, idempotency key |
| Ticket events | Assignment and status history | Ticket ID, event type, actor, old/new values, timestamp |
| Ticket read markers | Per-viewer unread state | Ticket ID, viewer ID, last seen message or sequence |
| Admin audit events | Privileged action accountability | Actor, action, target, timestamp, request correlation, reason, safe change summary |
| Account restrictions | Explicit active restrictions | Customer ID, restriction type, state, reason, actor, applied/lifted timestamps |
| Notification outbox | Later durable email work | Event ID, recipient reference, delivery state, attempts, next attempt, provider result |
| Staff invitations | Later controlled onboarding | Intended verified email, intended role, inviter, expiry, acceptance/revocation state |

### 14.1 Extend existing tickets safely

Preserve existing UUIDs, customer ownership, readable references, creation dates, and messages. Do not recreate tickets or reset their numbers.

The original message can be migrated into the conversation table with deterministic deduplication, or projected as the first conversation entry until migration. Choose one source of truth and document it. Never show the original message twice or drop it during backfill.

Backfills must be safe to resume and verify. Existing contact-page behavior must remain compatible during deployment.

### 14.2 Data integrity

- Every public message belongs to an existing ticket.
- Customer authorship is derived from the authenticated user, not a supplied author ID.
- Staff authorship and role are verified at the time of action.
- Assignment targets must be active eligible staff.
- Read markers cannot expose or modify other users' private state.
- Ticket numbers remain unique and stable; gaps are acceptable.
- Idempotency constraints prevent duplicate replies and actions after retries.
- Status and assignment updates maintain coherent version and activity fields.

### 14.3 Retention and deletion

The existing ticket ownership relationship cascades ticket deletion when an Auth user is deleted. Adding messages, notes, and audit events requires an explicit review of deletion behavior before account-deletion features are introduced.

Choose retention periods and anonymization rules with the project owner before production rollout. This document does not invent legal retention requirements. Administrative audit records should not depend on retaining unnecessary message bodies or personal contact details.

## 15. Backend operations and contracts

Expose narrowly scoped operations instead of generic table-editing endpoints.

| Operation | Main checks | Result |
|---|---|---|
| Get staff context | Authenticated identity, active role, MFA requirements | Role and capabilities |
| List staff tickets | Role scope, assignment scope, bounded filters | Ticket summaries and next cursor |
| Get ticket details | Customer ownership or staff permission | Appropriate public/staff detail projection |
| Send customer reply | Ownership, lifecycle, length, rate limit, idempotency | Saved message and current ticket state |
| Send staff reply | Current staff access, assignment, lifecycle, idempotency | Saved message and current ticket state |
| Add internal note | Current staff access and assignment scope | Saved staff-only note |
| Change ticket status | Permission, allowed transition, reason/reply, version | Confirmed status and version |
| Assign ticket | Administrator/owner, eligible target, version | Confirmed assignment |
| Mark conversation read | Viewer access and valid message position | Updated viewer read marker |
| Restrict/restore trading | Later administrator/owner permission, reason, current state | Confirmed restriction state |
| Invite/change/revoke staff | Owner, fresh verification, last-owner protection | Confirmed access change |

### 15.1 Trusted and untrusted inputs

The client may supply a ticket reference, message body, desired transition, and idempotency key. It cannot authoritatively supply the actor's user ID, actor role, creation time, ownership, audit actor, or current permissions.

Validate all input lengths and allowed values on the server, even when the frontend has matching validation.

### 15.2 Standard error handling

Define stable application error categories: unauthenticated, forbidden, not found, validation failed, rate limited, conflict, and temporarily unavailable.

The UI maps those categories to helpful text. Do not display SQL errors or raw stack traces. For out-of-scope ticket identifiers, avoid responses that unnecessarily reveal another customer's data or ticket existence.

### 15.3 Atomic operations

When an action changes multiple records, commit them together. Examples include a reply plus a status change, an assignment plus history, and a restriction plus an audit record.

If the required audit write fails, the privileged state change should fail as well. External email delivery is not part of the database transaction; write a durable notification event in the transaction and deliver it later.

### 15.4 Concurrency

Use a ticket version or equivalent compare-and-update check for competing status and assignment changes. Return a conflict instead of overwriting unseen work. The UI should refresh the current state and let the staff member reconsider the action.

For message retries, reuse the same idempotency key for the same attempted message. A new intentional message receives a new key. Scope keys to prevent one user from replaying another's operation.

## 16. Authorization and data protection

### 16.1 Database access

Apply row-level policies or equivalent backend enforcement to every protected read. Administrative query helpers must not accidentally bypass assignment scope or customer ownership.

Privileged write functions must validate the caller and requested operation internally. If a function executes with elevated database privileges, use a fixed safe search path and tightly controlled execution grants.

### 16.2 Server-only credentials

Never include service-role credentials, Auth administration keys, database passwords, or email provider secrets in HTML, browser JavaScript, or client configuration.

Operations needing those credentials execute on the server, where the caller's current staff permission must be verified before the privileged downstream call.

### 16.3 Sensitive data visibility

Agents see limited customer information only in the context of assigned work. Never display password hashes, tokens, recovery codes, or wallet recovery phrases.

Logs and audits should identify a ticket and action without copying full message content or authentication credentials. Error telemetry must be scrubbed of sensitive values.

### 16.4 Rate limiting

Keep the existing new-ticket limit. Define separate limits for replies, internal notes, search, and expensive administrative operations so the new dashboard does not bypass abuse controls.

Enforce limits on the backend. Client button disabling is duplicate-click protection, not rate limiting.

## 17. Customer administration: later phase

### 17.1 Customer directory

Administrators and owners can search accounts using approved identifiers. Results should show only the minimum useful summary: display name, account identifier suitable for staff, sign-up date, relevant restriction state, and support context.

Account details can show a customer's tickets and approved demo-account information. Do not create an unrestricted dump of all database fields.

### 17.2 Trading restriction

A trading restriction blocks new order submission but leaves sign-in and support access available.

Implementation must specify what happens to existing open orders and their execution. The proposed safe first behavior is to block new submissions while leaving cancellation available; the handling of already resting orders must be decided explicitly before enabling the restriction feature.

Show the customer an understandable restriction message and a support path. Avoid exposing confidential internal investigation notes.

### 17.3 Sign-in restriction

Disabling sign-in is separate from restricting trading. It is an owner-only later-phase action requiring recent verification, an explicit reason, and an audited server operation.

Before introducing it, define how affected customers can seek help because the current support form requires sign-in. Do not ship account lockout without an agreed recovery/contact process.

### 17.4 Restoration

Restoration is an explicit action with permission checks and an audit record. Preserve the historical restriction and who lifted it instead of deleting the evidence that it existed.

## 18. Trading and operational oversight: later phase

Provide read-only inspection of demo accounts, orders, execution events, and relevant ledger summaries. Display DEMO clearly.

The dashboard may help an administrator investigate a failed demo order or stale market data. It must not permit arbitrary price changes, balance overwrites, ledger deletion, or manufactured fills.

If a demo-balance reset or correction is later required, design a dedicated audited accounting operation. Do not implement it as a general-purpose edit field.

Service-health views should show a measured timestamp and source. A green indicator must correspond to an actual check; missing observations should display “Unknown” or “No recent data.”

## 19. Overview metrics

The initial overview should prioritize actionable support information:

- Received requests awaiting handling.
- Unassigned requests, for administrators and owners.
- Requests waiting for customer information.
- Requests assigned to the current agent.
- Requests resolved in a clearly defined reporting period.

Every metric needs a defined scope, time window, and timezone. An agent's summary must reflect assigned work, not leak organization-wide information.

Do not introduce response-time targets, customer satisfaction scores, or uptime percentages before the necessary events and measurement definitions exist.

If average response time is later added, define whether it measures first public staff reply, how reopened tickets behave, and whether out-of-hours time is included.

## 20. Notifications and unread state

### 20.1 First release

Use in-application unread indicators based on persisted per-viewer read markers and public message events. Reading a ticket must not mark it read for every staff member.

Opening a conversation can advance a read marker only to the messages actually loaded. New messages arriving afterward should remain unread until viewed.

### 20.2 Later email delivery

Persist notification work after a reply or assignment is saved. Delivery must support retries, deduplication, bounded attempts, and visible failure state for operators.

Do not send internal notes to customers. Prefer minimal email content and a link to the authenticated conversation. The product must separately decide sender identity, notification preferences, and delivery monitoring.

Email delivery failure does not undo a saved reply. The staff interface should distinguish “Reply saved” from “Email delivered.”

## 21. Audit requirements

Record at least:

- Initial owner bootstrap.
- Staff invitation, acceptance, role change, and revocation.
- Ticket assignment and reassignment.
- Staff reply and internal-note creation, by identifier rather than copied body.
- Ticket status changes and reopening.
- Account restrictions and restoration.
- Sensitive configuration changes if any are introduced.

Each event should include an event ID, server timestamp, actor identity, action type, target type/ID, relevant reason, safe before/after summary, and a correlation identifier.

Application users, including owners, cannot edit or delete audit records. Audit visibility is permission-scoped. Infrastructure administrators remain a separate trust boundary; do not claim application-level append-only rules make a database physically impossible to alter.

Denied access and operational errors may be recorded in security/technical logs with suitable privacy controls. They should not expose protected customer content.

## 22. Performance, caching, and updates

- Query summary fields for lists; load message bodies on detail views.
- Index the actual ticket filters and ordering fields.
- Bound conversation loads and paginate long threads.
- Scope caches by user identity, role/access context, and query.
- Clear cached staff data on sign-out and role changes.
- Invalidate affected lists, details, and counters after confirmed mutations.
- Never use a cached role as backend authorization.
- Cancel or ignore stale requests when the selected ticket or user changes.

Realtime updates are optional for the first release. A reliable refresh action and correct mutation refresh are sufficient. If subscriptions are added, apply the same access scope and unsubscribe when access ends.

Choose polling intervals and aggregate-query frequency based on measured use rather than refreshing every component independently. Avoid loading all customers or all tickets into the browser for filtering.

## 23. Implementation phases and exit criteria

### Phase 1: Permission foundation

Deliver the authoritative staff-role model, access-context operation, protected admin shell, owner bootstrap procedure, MFA gate, audit infrastructure, and permission tests.

Exit criteria:

- Customers cannot enter or query the staff workspace.
- Active staff receive the correct capability set.
- Client-supplied role changes have no effect.
- Revocation blocks new protected requests.
- Last-owner protection holds under concurrent changes.
- Required audit events are written by the server.

### Phase 2: Complete support workflow

Deliver inbox, detail view, assignments, public replies, internal notes, status transitions, unread state, and the customer conversation view.

Exit criteria:

- A customer creates a ticket and sees its readable reference.
- An administrator assigns it to an agent.
- The agent replies; the customer can read and respond.
- Internal notes never appear in customer responses.
- Status changes follow the documented lifecycle.
- Reassignment removes the old agent's access.
- Retries do not duplicate messages.
- Existing tickets remain accessible with their original references.

### Phase 3: Customer administration

Deliver scoped customer search, account inspection, trading restrictions, and restoration after the unresolved restriction behaviors are agreed.

Exit criteria:

- Restricted customers cannot bypass restrictions through direct API calls.
- Permitted sign-in, support, and cancellation behavior remains available.
- Every restriction/restoration records an actor and reason.
- No direct balance or ledger editing is introduced.

### Phase 4: Staff management and operational oversight

Deliver owner staff-management screens, read-only demo inspection, meaningful health indicators, and expanded audit review.

Exit criteria:

- Invitations cannot grant a role other than the owner-approved one.
- Expired/revoked invitations cannot be accepted.
- Staff role changes take effect without requiring the affected user to cooperate.
- Reports use real data and documented time windows.
- Operational inspection preserves the DEMO-only boundary.

### Phase 5: Optional notification and workflow improvements

Add reliable email notifications, richer reporting, and carefully scoped workflow automation only after the preceding phases are stable.

Do not delay the basic support workflow by adding speculative automation or redesigning the entire customer application.

## 24. Verification plan

### 24.1 Permission tests

Test anonymous users, ordinary customers, each staff role, revoked staff, and staff without the required MFA state. Call backend operations directly, not only through visible buttons.

Verify cross-customer isolation, assignment isolation, owner-only operations, denied direct writes, and the inability to supply a different actor identity.

### 24.2 Workflow tests

Verify ticket creation, assignment, public reply, customer reply, waiting state, resolution, reopening, and closure. Include existing tickets created before the dashboard migration.

### 24.3 Race and failure tests

Test double submission, uncertain network outcomes, concurrent assignment, concurrent status changes, revoked access during an open ticket, delayed responses after sign-out, and backend errors while a draft is present.

Verify transaction rollback when history/audit writes fail. Verify that notification failures do not duplicate or remove saved messages.

### 24.4 Frontend checks

Check actual rendered pages at desktop and mobile widths. Verify loading, empty, error, denied, expired-session, and success states. Test keyboard navigation, readable status labels, and focus after important actions.

Confirm there is no dummy data and that the signed-in state is consistent throughout the page.

### 24.5 Regression checks

Run existing contact and caching tests when affected. Ensure normal customer authentication, support submission, and demo trading behavior continue to work.

Tests should verify outcomes and access boundaries rather than merely repeat implementation details.

## 25. Deployment and rollback approach

1. Apply additive schema changes in a development or staging environment.
2. Backfill existing ticket conversations and verify counts/references.
3. Test permission policies and server operations before exposing admin navigation.
4. Establish the intended owner through the controlled bootstrap process.
5. Verify MFA and fresh-authentication requirements.
6. Deploy the staff frontend and compatible customer conversation changes.
7. Run end-to-end checks with distinct customer, agent, administrator, and owner accounts.
8. Enable access for a small initial staff group and monitor failures.

Prefer additive migrations and compatibility windows so old customer pages continue to work during rollout. Do not remove a working support endpoint until its callers have migrated.

Rollback should disable the new UI or revoke new access safely while retaining tickets, messages, and audit history. Destructive deletion of operational data is not a rollback strategy.

## 26. Decisions to resolve before dependent implementation

These questions do not prevent building the basic schema and permission tests, but each must be answered before its dependent feature is released.

| Decision | Proposed starting point | Must be settled before |
|---|---|---|
| Initial owner identity | Verified existing account chosen by project owner | Staff access deployment |
| MFA enrollment/recovery and verification freshness | Mandatory staff MFA; explicit freshness window for sensitive actions | Staff access deployment |
| Message/note size and rate limits | Bounded server-enforced limits, documented beside API contracts | Conversation release |
| Staff display identity | Support display name without personal staff contact details | Public staff replies |
| Support-data and audit retention | Explicit project policy; no invented retention period | Production staff rollout |
| Handling of existing orders during trading restrictions | New submissions blocked; cancellation retained; resting execution decision outstanding | Restriction release |
| Help path for sign-in-disabled accounts | Separate verified recovery/contact process | Sign-in restriction release |
| Email sender and notification preferences | In-app notifications first | Email release |
| Reporting timezone | Explicit project timezone with localized display where helpful | Metric/report release |

## 27. Definition of done

A feature is complete only when its frontend, backend enforcement, failure behavior, audit behavior, and relevant tests are implemented together.

For the first admin release, completion means:

- The correct staff can access the dashboard and ordinary customers cannot.
- Roles are authoritative and cannot be self-assigned.
- Staff can handle real customer tickets from intake through resolution.
- Customers can read and answer public replies.
- Internal notes stay internal at the data-access boundary.
- Readable ticket references remain stable.
- Changes are confirmed by the backend and important failures preserve user work.
- Revocation, reassignment, concurrency, and retry behavior are verified.
- Privileged actions leave an audit trail.
- The UI contains real data and accurate authentication states.
- Existing customer and demo-trading functionality remains intact.
- Deployment and operator procedures are documented.

## 28. Suggested first development backlog

1. Implement staff role storage and permission helpers.
2. Implement owner bootstrap and last-owner protection.
3. Add staff MFA/access-context enforcement.
4. Add audit storage and transactional audit helpers.
5. Extend ticket state and add assignments, messages, notes, events, and read markers.
6. Backfill or project original ticket messages without duplication.
7. Implement scoped inbox and detail queries.
8. Implement assignment, reply, note, transition, and read-marker operations.
9. Build the protected staff shell and inbox.
10. Build ticket detail, public reply, and internal-note interfaces.
11. Extend the customer page with conversations and older-request navigation.
12. Verify permissions, workflow, concurrency, accessibility, and regressions.
13. Write operator instructions and perform a staged rollout.

This sequence is the implementation starting point. The permission foundation and support workflow should be completed before adding broader administrative controls.

## 29. Full platform administration scope

The completed dashboard is the staff workspace for running the application. Support is one module within that workspace. Each module below must have its own data sources, permissions, safe actions, audit requirements, and acceptance tests.

### 29.1 Module map

| Module | Main responsibility | Examples of real administrative work |
|---|---|---|
| Platform overview | Show the condition of the application | Identify unanswered requests, failed processing, stale prices, and active incidents |
| Customer accounts | Manage account lifecycle and access | Find an account, inspect verification state, apply a scoped restriction, restore access |
| Support | Resolve customer questions and problems | Assign tickets, reply, add notes, track resolution |
| Demo trading | Supervise simulated trading behavior | Inspect orders, investigate failed fills, reconcile virtual accounting |
| Markets and instruments | Control supported demo markets and monitor quotes | Review quote freshness, manage approved symbols, pause new orders for a failing instrument |
| Content management | Maintain customer-facing published information | Publish blog posts, edit FAQs, update About content and verified contact details |
| Communications | Deliver useful notices | Publish maintenance announcements and track transactional notification failures |
| Security and abuse | Investigate suspicious activity and protect accounts | Review security events, revoke sessions, enforce scoped restrictions |
| Operations and integrations | Keep background services working | Inspect scheduled jobs, troubleshoot provider errors, retry supported idempotent jobs |
| Reporting | Measure actual platform activity | Report customer growth, ticket handling, demo order outcomes, and service reliability |
| Staff and permissions | Control who can operate the platform | Invite staff, assign scoped responsibilities, review access, revoke access |
| Platform settings | Manage explicitly supported configuration | Change approved support settings, configure banners, manage scoped maintenance modes |
| Audit and governance | Explain administrative actions | Review changes, access decisions, publishing actions, and incident timelines |

All of these are planned modules. A module is not implemented merely because it appears in navigation or this table. Its screen should ship only when meaningful backend functionality exists.

### 29.2 Platform overview

The overview should answer: **What needs attention now?**

It should combine permission-scoped summaries from the modules the viewer can access. Useful cards include unassigned support requests, customers waiting for replies, failed demo processing, stale market feeds, failed notification deliveries, and active maintenance incidents.

Each card should link to the filtered operational view behind it. Show the reporting period and last observation time. Missing data is “Unknown” or “Unavailable,” not zero and not healthy.

Do not show deposits, real trading revenue, assets under custody, or withdrawal totals in a demo-only product. Demo volume and virtual balances must be labeled as simulated metrics.

### 29.3 Customer accounts

The customer module should provide a single operational view of an account, with tabs or sections for approved profile fields, account status, support history, restrictions, and permitted demo-account activity.

Planned capabilities:

- Search by exact account identifier, email, or display name with scoped results.
- Inspect sign-up date and email verification state from authoritative authentication data.
- View active restrictions and their reasons according to staff permission.
- Review account-related support tickets without bypassing ticket access rules.
- Initiate an established password-recovery workflow without choosing or viewing the customer's password.
- Apply and lift explicit restrictions through protected operations.
- Inspect relevant session/security summaries only for authorized security staff.

Profile correction should be narrowly defined. Updating a display name is different from changing an authentication email. Email changes and recovery actions require a separately specified identity-verification workflow; a support message alone is insufficient authorization.

Do not add an arbitrary “edit user” form that can modify roles, verification state, account ownership, or balances. Every editable field needs an intentional permission and audit rule.

Required backend capabilities include scoped search, a safe account summary projection, explicit restriction operations, and server-side Auth administration where necessary. Authentication management cannot be implemented with browser secrets.

### 29.4 Demo trading administration

This module is for understanding and operating the simulated execution system.

Initial capabilities are read-only:

- Search orders by customer, symbol, status, and time range.
- Inspect order submission, reservation, execution, cancellation, and failure events.
- Compare order state with fills and virtual ledger movements.
- Identify orders waiting on stale or missing quotes.
- View aggregate demo activity with clear simulated-money labels.
- Review reconciliation reports that flag inconsistencies without silently repairing them.

Later controlled operations may include pausing new demo submissions, cancelling eligible demo orders through the existing order lifecycle, or requesting a specifically designed demo-account reset. These are separate features, not permission to directly change database records.

Any cancellation must release reservations correctly, respect fill/cancellation races, and record its actor and reason. A reset must define how open orders, positions, and virtual balances are handled atomically. Until that design exists, do not expose reset controls.

No role may fabricate a completed fill, manually set a historical execution price, or overwrite ledger history. Corrective accounting must use explicit compensating entries under a separately reviewed operation.

### 29.5 Markets and instruments

This module determines which instruments the demo engine supports and whether their data is suitable for trading.

Planned capabilities:

- View approved symbols and their actual execution availability.
- Inspect the last trusted quote time, source, bid/ask values, and freshness state.
- Distinguish data displayed on a chart from data trusted by the execution backend.
- Manage an approved instrument registry once the backend uses that registry authoritatively.
- Pause new submissions for a symbol with stale or failing data.
- Review precision, minimum size, and other supported execution constraints.
- Inspect provider failures and rate-limit conditions.

A symbol appearing in the UI does not make it executable. Symbol enablement must verify data ingestion and backend support before the customer trading UI offers it.

Before implementing symbol pauses, define effects on resting orders, cancellation, and matching workers. All order entry paths must enforce the same setting; hiding a market in the frontend is insufficient.

Staff must not manually enter a favorable market quote or bypass quote freshness to make an order execute.

### 29.6 Content management

The application has landing, About, blog, blog-detail, and FAQ pages. These need a content workflow rather than hardcoded placeholders or unrestricted file editing through the dashboard.

Planned content types:

- Blog articles: title, slug, summary, body, author display name, image metadata, publication state, and publication timestamp.
- FAQs: question, answer, category, display order, and publication state.
- About and landing-page sections: approved structured text and media fields.
- Contact information: verified support channels and availability statements.
- Legal/informational pages: versioned approved content, with review ownership defined before publication.

Use a draft → review → published → archived workflow. Editors can prepare and preview content; publishers approve publication. The owner can perform publication where authorized but cannot bypass sanitization or audit recording.

Required functionality includes preview, validation, version history, publication scheduling if implemented, unpublishing, and restoration of an earlier version. Restoring a version creates a new recorded publication action; it should not erase intervening history.

The backend must enforce unique slugs and permitted publication transitions. Public pages read only published content. Drafts must not become available through public API requests or predictable preview links.

Start with plain text or a restricted structured editor. If rich text is supported, sanitize rendered output and validate links. Media uploads require an actual storage, file-validation, and access policy before enabling upload controls.

Do not publish unverified claims about support hours, office addresses, returns, regulation, or available trading features. Content management is not a reason to reintroduce the placeholder claims removed from the contact page.

### 29.7 Communications and announcements

Separate three communication types:

| Type | Example | Required behavior |
|---|---|---|
| Service announcement | Planned maintenance banner | Approved content, explicit audience, start/end times, publish/unpublish history |
| Transactional notification | A support reply is available | Triggered by a real event, deduplicated delivery, retry handling, privacy-safe content |
| Marketing communication | Promotional campaign | Separate consent, audience, unsubscribe, and approval design before implementation |

The initial scope should include service announcements and in-app transactional notifications. Marketing campaigns remain out of scope until their operational and consent requirements are agreed.

Staff need to see whether a notification is queued, delivered, failed, or awaiting retry. A notification operator may retry a supported failed delivery without creating another support message or repeating the underlying business action.

Audience previews must respect data permissions. A content editor should not receive a customer email export merely to publish a banner.

### 29.8 Security and abuse management

Security staff need evidence and narrowly scoped controls, not a universal ban button.

Planned capabilities:

- Inspect available authentication/security events with appropriate retention and privacy limits.
- Review repeated failed actions, suspicious request rates, and abuse reports.
- Record an investigation and link related accounts, tickets, and audit events where authorized.
- Apply supported restrictions with a reason and review state.
- Revoke customer sessions through protected server operations when the security role explicitly permits it.
- Escalate sign-in disablement to the owner under the existing sensitive-action rule.
- Review administrative access changes and unusual privileged activity.

Security flags are evidence to investigate, not proof of misconduct. Do not automatically confiscate funds, alter demo history, or permanently delete accounts based on a flag.

Do not assume all desirable telemetry already exists. Every signal shown must name a real data source and observation time. Adding device, network, or geolocation collection requires a separately defined need and data-handling policy.

### 29.9 Operations and integrations

This module covers background work and external service dependencies.

Planned capabilities:

- View scheduled job runs, start/finish times, duration, and outcomes.
- Inspect market-refresh and demo-order-processing failures.
- Monitor notification delivery jobs when implemented.
- View integration health, last successful contact, and safe error categories.
- Inspect cache freshness and capacity metrics if those observations exist.
- Retry only operations that have documented idempotency and bounded retry behavior.
- Record incidents and publish approved service-status announcements.

“Retry job” must name the exact operation and show its expected effect. It must not run arbitrary shell commands, SQL, or user-supplied code from the browser.

The dashboard may display whether an integration is configured and healthy, but must never display its secret token. Secret rotation stays in a protected operational workflow; a generic credentials editor is excluded.

### 29.10 Reporting and analytics

Reports should answer specific operational questions:

- How many accounts were created in a selected period?
- How many accounts used the demo product, under a documented activity definition?
- How many tickets are received, answered, waiting, resolved, or reopened?
- How long does first public support response take?
- Which demo orders fail, and for which known reasons?
- Which market feeds or jobs are repeatedly stale or failing?
- How often do privileged administrative changes occur?

Define denominators, reporting periods, timezone, event source, and freshness. Do not equate signed-up accounts with active users or completed demo trades with actual revenue.

Analysts should receive aggregate or suitably minimized data by default. Individual customer drilldown requires a separate permission. Bulk export remains excluded unless an explicit scoped export design is approved.

### 29.11 Platform settings

Settings must be an allowlisted set of typed, validated configuration options. Every option needs an owner, default, allowed values, application point, and rollback behavior.

Potential settings include ticket categories, support display information, public announcement scheduling, approved demo instrument availability, and scoped maintenance controls.

For each setting, document whether it affects new operations only or existing operations too. Record before/after values when safe, the actor, and the reason. Keep secrets out of settings audit payloads.

A maintenance banner is informational. A maintenance restriction changes backend behavior. These must be separate controls so displaying a notice is never mistaken for actually blocking writes.

Configuration changes affecting execution or access must be enforced server-side, not merely read by the frontend.

### 29.12 Audit and governance

Extend the audit requirements in section 21 across all modules: content publication, instrument availability, job retry, notification retry, settings changes, restrictions, staff access, and any future corrective accounting operation.

An auditor needs to reconstruct a timeline using stable identifiers and safe summaries. Audit visibility does not automatically grant permission to read all customer messages, authentication events, or internal investigation details.

## 30. Specialist roles for the expanded platform

The initial four-role structure is sufficient for the first support release. It is not sufficient as the permanent model for every operational function.

Introduce specialist roles only when the corresponding modules are implemented. Store authorization as explicit capabilities associated with role templates so future roles do not require ad hoc checks throughout the codebase.

| Role | Primary responsibility | Typical permissions | Explicit limits |
|---|---|---|---|
| Support agent | Handle assigned customer requests | Assigned tickets, replies, notes, permitted transitions | No full customer directory, execution controls, publishing, or staff management |
| Administrator | Coordinate customer and support operations | Ticket assignment, approved customer inspection, scoped account restrictions | Not automatically an editor, security investigator, execution operator, or staff-role manager |
| Trading operations specialist | Investigate and operate demo execution | Demo records, reconciliation reports, approved instrument pauses and operational actions | No manual ledger edits, fake fills, customer impersonation, or REAL execution |
| Content editor | Prepare site content | Create/edit drafts and preview authorized drafts | Cannot publish without publisher permission; no customer data access |
| Content publisher | Approve public content | Review, publish, unpublish, restore approved content | No trading/access configuration or customer directory by default |
| Security analyst | Investigate account/security issues | Scoped security events, cases, permitted restrictions and session revocation | No staff role grants; owner approval for sign-in disablement |
| Operations operator | Maintain service processes | Safe job health, bounded retries, integration health, incident workflow | No arbitrary code execution, secret viewing, or unrestricted customer data |
| Reporting analyst | Understand platform trends | Approved aggregate reports | No operational mutations or automatic customer-level access |
| Auditor | Review privileged activity | Read-only audit views and approved evidence | No mutations and no automatic access to all sensitive payloads |
| Owner | Control organizational access and sensitive policy | Staff roles, sensitive approvals, explicitly granted module capabilities | Still subject to MFA, audit, validation, and immutable-record rules |

### 30.1 Role composition

The initial implementation can use one role per staff member. Before specialist roles ship, introduce role membership and capability resolution that permit explicit combinations, such as editor plus publisher, without turning that person into an administrator.

Do not let a staff member edit their own capability set. Role-template modifications and assignments are owner actions and must be audited. Avoid user-specific permission exceptions until there is a demonstrated need and a manageable review process.

### 30.2 Capability naming

Suggested capability families include `support.read_assigned`, `support.assign`, `customers.read`, `customers.restrict_trading`, `trading.read_demo`, `markets.pause_demo`, `content.edit_draft`, `content.publish`, `security.read_events`, `security.revoke_sessions`, `operations.retry_job`, `reports.read_aggregate`, `audit.read`, and `staff.manage`.

These are proposed identifiers, not existing permissions. Each capability must map to tested backend operations and scoped reads. A broad `is_admin` flag must not silently bypass every check.

### 30.3 Separation of responsibilities

Where a future action needs independent approval, record both the requester and approver and prevent self-approval. Do not claim two-person approval exists merely because a confirmation dialog appears.

The first support release does not require two-person approval for routine replies or assignments. Sensitive new functions should define their approval model individually before implementation.

## 31. Future financial and compliance scope

An exchange-style product might eventually need deposits, withdrawals, payment reconciliation, fees, identity verification, and financial reporting. Those functions are **not part of the current DEMO-only backend** and must not be represented as working admin features.

If the project separately approves real-money functionality, it will require a new foundation covering supported jurisdictions, applicable professional/legal review, identity handling, custody/payment architecture, transaction authorization, reconciliation, incident handling, and customer disclosures.

Potential later roles include finance operator, independent approver, and compliance reviewer. Their existence in a future plan must not grant the current administrator unrestricted balance-changing powers.

For now:

- A support ticket categorized as “deposit” or “withdrawal” is an inquiry, not a financial transaction.
- The admin may answer the inquiry but cannot approve a transaction that the backend does not implement.
- Demo balances must never be labeled as withdrawable funds.
- Do not add fake KYC approval controls or collect identity documents without an implemented purpose and protected workflow.

## 32. Cross-module frontend and backend design

### 32.1 Shared frontend shell

Use a common shell with permission-filtered navigation, current staff identity, consistent loading/error states, and links to audit details where authorized.

Suggested navigation groups:

- **Overview**: actionable platform summary.
- **Customers**: directory, account details, restrictions.
- **Support**: inbox and conversations.
- **Trading**: demo orders and reconciliation.
- **Markets**: instruments and quote health.
- **Content**: blog, FAQ, site sections, announcements.
- **Security**: events and investigations.
- **Operations**: jobs, integrations, incidents.
- **Reports**: approved analytics.
- **Administration**: staff, allowlisted settings, audit.

Do not show unavailable modules as if their controls work. Navigation should follow delivered capabilities and the current viewer's permissions.

### 32.2 Backend boundaries

Each module owns its write operations and validates its own invariants. Shared services provide identity, authorization, auditing, rate limits, and standardized errors.

Examples of planned operations include publish article, restrict trading, pause instrument, retry notification, assign ticket, and grant staff role. Each should have a narrow input schema and explicit backend authorization; there should be no generic “admin execute” endpoint.

### 32.3 Cross-module links

Link related resources without weakening permissions. A ticket may link to a demo order, but following the link still requires trading-read permission. An incident may link to an integration failure without revealing credentials. An audit event may identify a restricted resource without returning its full contents.

### 32.4 Shared operational contract

For every new administrative action, document:

1. Who can perform it and on which records.
2. Required authentication strength and freshness.
3. Inputs and validation.
4. Exact authoritative state change.
5. Effects on existing work and downstream modules.
6. Transaction and concurrency behavior.
7. Retry/idempotency behavior.
8. Audit record and customer-visible effects.
9. Failure/recovery behavior.
10. Tests that prove the access boundary and outcome.

## 33. Broader delivery roadmap

The support phases in section 23 define the first operational slice. The expanded platform should then be delivered in bounded milestones rather than attempting every module at once.

| Milestone | Deliverables | Why this order |
|---|---|---|
| A. Access foundation | Staff permissions, MFA, audit, shared shell | Every module depends on reliable access control |
| B. Support workflow | Inbox, assignment, conversation, customer replies | Existing requests immediately need a real handling workflow |
| C. Customer operations | Directory, scoped account view, explicitly designed restrictions | Provides controlled account administration |
| D. Content publishing | Draft/review/publish workflow for FAQ, blog, and selected site content | Replaces static content maintenance with real editorial operations |
| E. Demo trading and markets | Read-only inspection first, then approved instrument controls | Extends oversight without compromising execution integrity |
| F. Operations and communications | Job health, safe retries, announcements, notification delivery | Makes reliability work visible and actionable |
| G. Security specialization | Security event views, investigation workflow, scoped response actions | Requires deliberate telemetry and stronger access boundaries |
| H. Reporting and access review | Defined metrics, audit review, specialist-role management | Builds on reliable operational events and mature module permissions |

Some read-only modules can be implemented independently after milestone A. The sequence is a proposed priority order, not a claim that content publishing technically requires customer restrictions.

Specialist role support must arrive before granting access to specialist modules. Staff invitations and owner controls may be delivered earlier as needed; they are not postponed merely because reporting is later in this table.

## 34. Expanded acceptance criteria

### Customer operations

- Search results respect role scope and reveal only approved fields.
- Restrictions are enforced by actual backend operations, not only the customer UI.
- Recovery actions never expose or let staff choose customer passwords.
- Staff can distinguish customer identity from a user-supplied support contact address.

### Content

- Drafts remain unavailable to unauthenticated public reads.
- Editors cannot publish without publisher permission.
- Published content appears on the real customer page and can be safely unpublished.
- Rendering does not execute submitted scripts or unsafe HTML.
- Version changes and publication actions are traceable.

### Trading and markets

- All values are clearly DEMO where applicable.
- Read-only staff cannot mutate orders or ledger data.
- Instrument controls affect every relevant backend entry point.
- Existing-order behavior during pauses is documented and tested.
- No role can create fabricated fills or bypass trusted pricing rules.

### Operations and communications

- Health is based on real observations with timestamps.
- Retrying work cannot repeat a non-idempotent underlying action.
- Credentials never appear in UI responses or logs.
- Announcement expiry and audience rules are enforced.
- Notification delivery state is distinct from business-action persistence.

### Security, reports, and governance

- Security views are limited to explicitly authorized staff.
- Report scope and metric definitions are documented and tested.
- Aggregate reporting does not unintentionally disclose customer-level information.
- Revoked roles lose access across all modules, including active subscriptions.
- New privileged operations consistently record audit events.

## 35. What the completed dashboard enables

The platform administration workspace should allow the business to manage customers, handle support, maintain accurate public content, supervise demo trading, monitor market data, operate services, communicate incidents, investigate security issues, and understand platform activity.

It should also control who can do each of those things and preserve evidence of important changes. Support is the first complete workflow; it is not the definition of the whole dashboard.

New functionality should be added as a tested module with clear ownership and permissions. The final measure of usefulness is whether authorized staff can perform real operational work safely and clearly, not how many panels or menu items the dashboard contains.

## 36. Backend resources and operations for broader modules

The support resource model in section 14 covers the first implementation. The broader modules also require persistent resources; frontend screens alone cannot provide the planned behavior.

The names below are conceptual. Reuse existing authoritative records where appropriate instead of duplicating customer identities, orders, or accounting data.

| Domain | Persistent resources | Protected operations | Integrity requirements |
|---|---|---|---|
| Staff permissions | Role templates, capabilities, memberships, invitations | Grant/revoke membership, invite, accept invitation | Owner authorization, last-owner protection, no self-granted permissions |
| Customer operations | Existing accounts and profiles; restriction history | Search approved fields, apply/lift restriction, initiate approved recovery | Current ownership and scope checks; no arbitrary account editing |
| Content | Content entries, revisions, publication records | Save draft, submit review, publish, archive, restore revision | Draft isolation, safe rendering, immutable revision history |
| Announcements | Announcement versions, audience rules, schedules | Preview, publish, expire, withdraw | Explicit time boundaries, approved audiences, audited publication |
| Markets | Approved instruments, configuration versions, availability changes | Propose/approve supported configuration, pause/resume new submissions | Backend enforcement and explicit resting-order behavior |
| Trading oversight | Existing orders, fills, ledger records; reconciliation runs | Read scoped records, run read-only reconciliation | No direct mutation of financial history |
| Operations | Job run records, retry attempts, integration observations, incidents | Read status, retry approved job, update incident | Idempotent retries, bounded attempts, no secret disclosure |
| Security | Investigation cases, evidence references, response-action history | Open case, record finding, request/apply authorized response | Scoped evidence access, reasons, escalation rules |
| Notifications | Notification events, recipient/read state, delivery attempts | Mark read, retry eligible delivery | No duplicate underlying action; internal notes excluded from customer delivery |
| Settings | Typed settings, revisions, change history | Validate, apply, revert approved setting | Allowlist, version checks, backend consumption, safe defaults |
| Reporting | Metric definitions and derived summaries where justified | Read authorized aggregate reports | Defined windows and denominators; no invented statistics |

### 36.1 Content publication transaction

Publishing must verify publisher capability, validate the selected revision, check for concurrent edits, record the publication, and create an audit event. Only the committed published revision becomes eligible for public reads.

If public content uses a cache, invalidate it after the transaction succeeds. A cache invalidation failure must be observable and retryable. The UI must not claim that all public caches are updated solely because the publication record was saved.

Unpublishing removes the entry from public read scope without deleting revision history. Links to unpublished content must return an appropriate unavailable/not-found view rather than exposing drafts.

### 36.2 Instrument availability transaction

Pausing an instrument must validate current permission, record the previous and new availability state, require a reason, and write an audit event. Order submission must check authoritative availability inside its execution boundary.

Resuming must verify the configured readiness requirements, including usable trusted quotes. A successful resume request must not override stale-price protection elsewhere in the engine.

An instrument pause is not the same as cancelling its existing orders. Those effects must be separate unless a specifically designed combined operation makes them atomic and clearly explains the outcome.

### 36.3 Job retry contract

A retry references an existing failed job or delivery record. The server determines which operation and parameters are eligible; staff cannot submit an arbitrary executable payload.

The backend must check retry eligibility, permission, current attempt state, and the retry budget. Concurrent clicks must not create duplicate active attempts. Store a new attempt record linked to the original work and return a tracking identifier.

The UI initially reports “Retry queued” or “Retry started.” Only a confirmed terminal outcome can be reported as completed.

### 36.4 Settings application contract

Each setting must declare whether a change is immediate, scheduled, or requires a separate deployment. Do not label a setting applied when it merely saved a desired value that no active service consumes.

Use version checks for competing edits. Reverting a setting creates another recorded change to the prior value. Do not delete the intervening history.

For settings affecting access or execution, release tests must demonstrate enforcement through direct backend requests, including requests from an already-open customer browser.

### 36.5 Security response contract

Investigation notes and evidence do not automatically authorize a restriction. A response operation checks the acting staff capability and the exact action being requested.

Session revocation, trading restriction, and sign-in disablement are distinct operations with different effects. The UI must describe which is being performed. A staff member cannot use a weaker permission to invoke a stronger response indirectly.

Security events must preserve their source and timestamp. Where the platform lacks a signal, show that limitation rather than producing a suspicious-activity score from fabricated inputs.

## 37. Module readiness and implementation decisions

### 37.1 Readiness checklist for every module

Before beginning a module's frontend, identify its authoritative data source and protected backend contract. Before releasing it, verify all of the following:

1. Its responsible role and capabilities are defined.
2. Its useful read views work with actual records and bounded queries.
3. Its mutations enforce scope, validation, concurrency, and retry behavior.
4. Its customer-visible effects are defined and implemented where applicable.
5. Its audit events are recorded without unnecessary sensitive content.
6. Its empty, loading, failed, denied, and successful states are distinguishable.
7. Its permissions hold for direct requests outside the UI.
8. Its operational failure and recovery procedures are documented.
9. Its deployment preserves existing customer behavior.
10. Its navigation is exposed only to authorized staff after it works.

### 37.2 Decisions beyond the first support release

| Module | Decision needed | Proposed starting position |
|---|---|---|
| Customer accounts | Which profile corrections can staff make? | Read-only inspection first; approve each editable field separately |
| Content | Which pages become managed content first? | FAQ and blog, followed by structured About/landing sections |
| Content | Who may approve publication? | Owner-approved publisher capability, separate from editing |
| Markets | Who approves instrument configuration changes? | Owner-defined trading operations authority; no blanket administrator grant |
| Trading | What happens to resting orders during pauses/restrictions? | Resolve before enabling pause/restriction controls |
| Security | Which telemetry is available and necessary? | Use existing justified signals; do not start broad data collection by default |
| Operations | Which jobs are safe to retry? | Explicit allowlist backed by idempotency tests |
| Communications | Which audiences may receive announcements? | All signed-in customers or public visitors, with explicit per-announcement selection |
| Settings | Which settings are consumed by active services? | Expose only implemented typed settings |
| Reporting | What qualifies as an active user? | Adopt and document an actual event-based definition before displaying the metric |
| Specialist access | Can staff hold multiple roles? | Explicit memberships before specialist modules are released |

These decisions should become small implementation specifications at the relevant milestone. They do not justify building dummy controls while backend behavior remains undefined.

### 37.3 Scope changes

Adding real payments, withdrawals, custody, identity-document review, customer impersonation, or unrestricted exports changes the risk and architecture of the platform. Such a request requires an explicit addition to this foundation and a separate implementation design before coding dependent controls.

Ordinary improvements within an approved module—such as clearer filters, better empty states, or an indexed query—can proceed within its existing permission and data-handling boundaries.
