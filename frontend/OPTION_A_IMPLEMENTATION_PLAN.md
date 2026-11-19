# BML LMS — Option A implementation plan

## Scope

Option A in the supplied meeting document is a comprehensive, fully integrated loan management system with full ownership and integration arrangements for BML's long-term growth. The system must support Group Loans and Business Emergency Loans through assessment, approval, disbursement, repayment, and post-disbursement loan management. It must also support mobile/virtual-office work, evidence capture, virtual Credit Committee review, approval records, audit history, automated loan calculations and PAR, and reporting by customer, group, officer, centre, zone, and management.

This plan treats the current React/Vite frontend and Express/PostgreSQL backend in this repository as the starting point. It is an implementation proposal, not a claim that hosting, integrations, electronic signatures, or costs have already been agreed. Those need confirmation with BML during requirements sign-off.

## Current project assessment

- **Frontend:** React + TypeScript + Vite. It already has login, role-sensitive navigation, a dashboard, customer registration/listing, group identification/registration, and a field assessment form. Several navigation destinations still show a “not built yet” message.
- **Backend:** Express + TypeScript. It currently exposes health, authentication, and dashboard routes only. The frontend API client already sketches customer, group, and assessment calls, but matching backend routes are absent.
- **Database:** PostgreSQL schema currently contains users, a minimal clients table, loans, and a read-only audit log. It lacks group/member records, full applications and assessments, approvals, disbursement transactions, repayment schedules/payments, evidence metadata, and restructuring history.
- **Access control:** Frontend permission rules define loan officer, supervisor, committee, finance, management, and admin roles, but backend authorization and role definitions need to be brought into parity. The current database role constraint does not include committee or admin.
- **Architecture gap:** Root-level `src/` appears to be the active app (the root `package.json` runs Vite); a second `bml-lms/frontend` tree exists. Confirm the canonical frontend and consolidate or document the duplicate before feature work.

## Proposed application screens

1. **Role dashboard and work queue** — portfolio totals, due/overdue, applications by lifecycle stage, tasks assigned to the logged-in role, and filters for zone, centre, product, and officer. Officers see their own records; managers see authorized aggregate views.
2. **Customer and group intake** — self-registration or officer-assisted client introduction, timestamp and source, duplicate checks, group identification, member registration, and customer consent/contact details.
3. **Field assessment** — qualitative observations and risks; sales, working capital, assets, cash flow, obligations, requested amount and recommendation; visit location/time; photos and supporting documents; draft save and submission.
4. **Verification and Credit Committee** — supervisor checklist and return-for-correction path; committee case pack with evidence, comments, decision, conditions, recorded approvers, timestamps, and immutable audit events. Virtual meeting access can be integrated after BML selects a provider.
5. **Approval and signing** — approval limits/authorization, decision record, conditions, document generation, and signature/endorsement status. Electronic signature integration is a separately confirmed provider-dependent capability.
6. **Disbursement** — approved-versus-disbursed amount, borrower/account, date, channel/reference, finance confirmation, and activation of the repayment schedule.
7. **Repayments and arrears** — schedule, amount due/paid, outstanding balance, receipt/reference, partial/late payment handling, arrears follow-up, and reconciliation status.
8. **Loan management and reporting** — refinancing/rescheduling/restructuring records, portfolio monitoring, PAR, repayment performance, and downloadable reports filtered by customer/group/officer/centre/zone/product/date.
9. **Administration and audit** — users/roles, loan products and calculation parameters, centres/zones, workflow settings, integrations, and searchable read-only audit history.

## Delivery sequence

| Stage | Work | Completion evidence |
|---|---|---|
| 0. Confirm and design | Validate products, workflow states, decision limits, formulae, required evidence, centres/zones, role matrix, data migration, hosting/ownership, integrations, retention and security with BML. Produce approved screen flows and data dictionary. | Signed requirements and acceptance criteria; confirmed hosting and integration decisions. |
| 1. Foundation | Consolidate frontend location; establish migrations, API validation/error conventions, server-side permissions, audit events, configuration/secrets, backup plan, and test/staging environments. | Deployable baseline with documented environments and reviewed role matrix. |
| 2. Intake and assessment | Complete client/group/member APIs and persistence; implement introduction timestamps, duplicate checks, assessment workflow, calculation inputs, secure evidence upload/metadata, and offline-friendly draft handling for field work. | Loan officer can register, assess, save evidence, and submit both product types. |
| 3. Verification and approval | Add supervisor verification, correction loops, committee queue/case view, decision and conditions, authorization, and approval/audit history. | Authorized approvers can review and decide with timestamped records. |
| 4. Disbursement and repayment | Add disbursement recording, schedule generation using BML-approved product rules, payment entries/import path, receipt references, balances, arrears, and reconciliation controls. | Finance can disburse and record payments; balances reproduce approved rules. |
| 5. Loan management and reports | Add arrears worklists, rescheduling/restructuring/refinancing history, PAR calculations, dashboards and role-scoped reports across operational dimensions. | Reconciled portfolio/PAR reports with traceable source records. |
| 6. Integration, pilot, rollout | Integrate only confirmed services (e.g. payment channel, SMS, identity, e-signature, virtual meetings); pilot both products with selected officers/centres; train users; remediate; migrate and go live in stages. | BML signs off pilot acceptance, operational runbooks, support and recovery procedures. |

## Core data and workflow recommendations

- Treat an application as a durable record separate from a customer, and retain its product, assigned officer, centre/zone, status history, and submitted snapshots.
- Keep approval decisions, disbursement transactions, repayment entries, and audit events append-only or versioned. A correction should create a traceable event, not erase history.
- Store evidence in private object storage; keep metadata, access controls, checksums, and references in PostgreSQL. Do not store sensitive image/document bytes in ordinary application tables.
- Configure interest, fees, instalment frequency, rounding, grace periods, and PAR definitions from BML-approved policy. Do not hard-code financial assumptions from the meeting notes.
- Enforce permissions and scope on the backend for every record and report; frontend hiding alone is not access control.
- Design for intermittent mobile connectivity: save drafts locally with clear sync state, avoid claiming successful submission until the server confirms it, and prevent duplicate submissions.

## Open decisions for requirements sign-off

1. Hosting/data residency, backups, disaster recovery, ownership of source code and operational accounts.
2. Final Group and Business Emergency product rules, affordability formulae, approval limits, committee quorum, and PAR convention.
3. Selected providers and costs for SMS, payments, e-signature, identity checks, virtual meetings, and file storage.
4. Whether offline field capture is required at launch and the permitted device/browser baseline.
5. Migration scope, user onboarding, retention periods, consent language, and support response times.

## Risks and controls

- **Financial calculation errors:** signed-off formula catalogue, test vectors from Finance, reconciliations, and versioned product rules before production use.
- **Sensitive data exposure:** least-privilege roles, server-side scoping, private evidence storage, encryption in transit/at rest, and access audit.
- **Connectivity interruptions:** resilient drafts, explicit sync status, idempotent submissions, and monitored retry handling.
- **Integration dependency/cost:** stage provider integrations behind agreed interfaces and confirm recurring charges and ownership before committing.
- **Scope expansion:** approve the Stage 0 workflow and acceptance criteria first; prioritize core lifecycle completion before optional integrations.
