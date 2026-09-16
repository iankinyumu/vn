# Contact support requests

The contact page uses Supabase Auth and `public.support_requests`. Migration
`20260916120000_support_requests.sql` was applied to the configured project.

- Sign-in is required to submit and view requests. The account panel follows the current session and sign-in/sign-out events. Password recovery is shown to guests.
- The browser shows success only after the submission RPC returns the expected internal UUID and a permanent reference such as `SP-1001`. Existing tickets also receive a number through `20260916130000_friendly_ticket_references.sql`.
- Requests are limited to five per account per hour in the database. The same request UUID can be retried without creating another row; editing the form starts a new request.
- RLS limits reads to the owner. Browser roles cannot directly insert, update, or delete requests. Anonymous callers cannot submit.
- Names, contact email, optional phone, topic, message, and consent timestamp are stored. The contact email is user supplied and is not proof of account ownership.
- Attachments, live chat, phone support, public office details, and response-time guarantees are not provided.

## Handling requests

Authorized operators can review `support_requests` in the Supabase Table Editor.
Use the numeric part of the SP reference in `ticket_number` to locate a request. UUIDs remain internal. Update `status` to `open`,
`in_progress`, `resolved`, or `closed`. Customers see that status on refresh.
Contact the customer separately using the provided contact details. This change
has no automated email delivery, reply thread, or operator notification service.
Never place the service-role key in the frontend. Define an operational retention
policy before collecting support data at scale; deleting an Auth user cascades
to their requests.

## Verification

Run `node --test tests/contact.test.mjs` for success, network failure/retry,
double submission, guest access, phone validation, and unconfirmed responses.
The deployed migration was also tested in a rolled-back transaction for valid
submission, duplicate UUIDs, invalid email, missing consent, the hourly limit,
owner reads, other-account isolation, and denied direct/anonymous writes.
Visual browser verification was unavailable in the implementation session.
