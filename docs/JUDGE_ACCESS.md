# Judge access

How to open Opening Night, what the app creates for you, how long each thing lasts, and what could still stop working before the end of judging. Checked on 2026-11-13.

## Open the app

1. Go to **https://paypal-ai-opening-night.vercel.app**. Use this address only. Addresses that contain a deployment code (for example `paypal-ai-opening-night-abc123-….vercel.app`) ask for a Vercel sign-in and are not meant for judges.
2. Press **Start the guided tour** (recommended), or **Open the blank Alder Hall rehearsal** if you have your own PayPal sandbox buyer. There is no account, password or invitation.

That button creates a private rehearsal for your browser: your own copy of the show, with its own plan, money records and history. Nothing you do affects another visitor, and no rehearsal is prepared in advance. A guided walk-through for judges is being added on top of the same on-demand rehearsal; the README describes it once it is released.

## The show date is fictional

The rehearsal is a fictional show at Alder Hall dated 14 November 2026. It runs on its own scenario clock, shown in the app as venue time, which you move forward yourself. The real date does not matter: a rehearsal opened in December plans, approves and runs the same way as one opened before 14 November. Real time is used only to stamp records and to bound the short approvals listed below.

## What is created for you, and for how long

| Created when you ask | Lasts | When it ends |
|---|---|---|
| Your rehearsal session (a cookie in your browser) | 7 days | The start page returns. Open a new rehearsal. |
| Saved rehearsals in the picker | Until the session that made them ends | They can no longer be opened. Their records stay stored. |
| Crew, supplier, driver and inspector clients opened from your rehearsal | 1 day | Open a new one from the production desk. |
| Supplier owner access | Up to 24 hours, never past your session | Open it again from the supplier desk. |
| Artist review invitation | 5 to 60 minutes, as you choose | Issue a new invitation. |
| Attendee ticket access | 15 minutes to 24 hours, as you choose | Issue a new one. |
| Supplier quote | 15 minutes | Request fresh quotes. |
| Equipment hold | 10 minutes | Reconfirm the hold. |
| Delivery handoff code | 15 minutes | Show a new code. |
| Payout approval, invoice approval | 10 minutes | Approve again. |
| Supplier-change approval | 15 minutes | Approve again. |
| Analysis of the final account | 20 minutes | Start a new analysis. |
| Wallet-saving request | 1 hour | Start a new request. |
| Ticket charge consent, remedy batch, capture consent, cancellation decision | 24 hours | Review and approve again. |

Every one of these starts counting when you create it. None is tied to the show date or to a date fixed in the app.

## When your session ends

After 7 days, or if you clear your cookies, the app shows the start page again. Press **Start the guided tour** to get a new rehearsal with a new 7-day session. The earlier rehearsal stays stored but cannot be reopened from the new session.

If the session ends while a page is open, the next action shows "Open a rehearsal session to continue." Reload the page, or go to the address above, and start a new rehearsal.

## Limits you might meet

- **New rehearsals:** at most 30 per hour and 200 per day across all visitors. Past that, the start page says new rehearsals are temporarily at capacity; existing rehearsals keep working. Try again within the hour.
- **Planning assistant, document compiler, voice:** these call a live model. If the model service is unavailable or rate-limited, the app reports that the request failed and keeps your saved state. The rest of the app does not depend on it.
- **Payments:** PayPal sandbox only. No real money moves.

## What could still expire before 31 December 2026

| What | Date | Effect | Who acts |
|---|---|---|---|
| Scheduling component license (Bryntum). The hosted key is a trial key. | Ends **25 December 2026** | From 26 December the timeline, scheduler, calendar and grid views are masked and do not render. Until then they show a small "Trial" badge. Everything else keeps working. | Owner: replace the key with a purchased or extended one. |
| Hosting subscription (Vercel Pro) | Renews 5 December 2026 | If the renewal fails, the site and its background worker can be paused. | Owner |
| Database (Neon, billed by usage through Vercel) | No fixed date | If billing lapses, rehearsals cannot be opened or read. | Owner |
| Model provider key and spending limit (OpenAI) | No fixed date | The planning assistant, document compiler and voice report failures. Nothing else is affected. | Owner |
| PayPal sandbox application and test accounts | No documented expiry | Live sandbox payment steps would fail and say so. Controlled and replayed records stay readable. | Owner |
| Access to the original qualification rehearsals behind the evidence receipts | 19 November 2026 | Those specific rehearsals can no longer be opened in the app. Their receipts under `docs/evidence/` are unchanged. Judges do not need them: every judge rehearsal is new. | No action; they are not extended. |
| Uncaptured sandbox payment holds on older records | 29 days after each was made | PayPal reports them as expired. New rehearsals create their own. | No action |

## Owner check

Run this on any day to confirm the judge path is alive. It needs no credentials.

```sh
node scripts/ops/judge-path-check.mjs                    # read-only
node scripts/ops/judge-path-check.mjs --create-session   # also opens one new rehearsal and reads it back
```

It checks the start page, required security headers, the health endpoint, that the background worker endpoint is configured, the evaluation report, and the end date of the scheduling license. It exits with code 1 if any check fails, and warns when the license ends before 31 December 2026 (`--until YYYY-MM-DD` changes that date; `--strict` turns warnings into failures).
