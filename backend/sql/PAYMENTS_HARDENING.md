# Payment provider setup

`schema.sql` defines the base application schema. `payments-hardening.sql` adds payment intents, payout intents, provider references, financial safeguards, and webhook inboxes. `npm run db:setup` applies both migrations in one transaction. It does not modify user accounts.

## Deployment

- Run `npm run db:setup` locally or `npm run db:setup:compiled` in production.
- Create the initial administrator separately with the documented bootstrap command.
- Existing Snippe and AzamPay payment history remains in the database. New customer repayments and loan payouts use Snippe.
- Preserve the additive schema and payment history during application rollback.

## Snippe configuration

Set `SNIPPE_BASE_URL`, `SNIPPE_API_KEY`, `SNIPPE_WEBHOOK_SECRET`, and `SNIPPE_WEBHOOK_URL`. Use the API base URL supplied by Snippe, keep the key and signing secret server side, and register the public HTTPS callback `/api/webhooks/snippe`. All four settings are required to enable payments.

The application uses Snippe for customer mobile money repayments and mobile money or bank payouts. Payout fees are quoted before a transfer is submitted. Loans activate only after Snippe confirms the exact transfer amount in TZS.

## Operational controls

- Customer payment attempts are linked to the authenticated customer's own active loan and block duplicate open requests.
- Bank payout requires a verified customer bank profile. The staff member who verifies bank details must differ from the payout initiator.
- A confirmed payout reversal freezes the loan for Finance review. The repayment ledger is preserved.
- The webhook inbox stores event metadata and a body hash, not raw customer payloads. Snippe webhook signatures and timestamps are verified before processing.

## Rollback and production readiness

Keep payment intents, payout intents, ledger links, webhook events, and reversal-review flags during application rollback. Validate collections, payouts, callback delivery and signature verification, duplicate callbacks, failed transactions, reversals, status reconciliation, and Finance review with Snippe sandbox credentials before live-money use.
