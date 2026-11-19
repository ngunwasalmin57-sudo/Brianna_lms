# BML Loan Management System

BML LMS is a React single-page application, an Express API, and a PostgreSQL database. The production stack serves the SPA and API on one HTTPS origin, keeps PostgreSQL private, and uses Caddy to provision and renew TLS certificates.

## Production hosting

### Host requirements

- A Linux host with Docker Engine and the Docker Compose plugin.
- A public DNS A record for `APP_DOMAIN` pointing to the host. If you publish an AAAA record, IPv6 must reach the host too.
- Inbound TCP ports 80 and 443, and UDP 443, open for Caddy certificate issuance and HTTP/3.
- A secure off-host backup destination for customer and loan data.

### First deployment

1. Copy `.env.example` to `.env`. Set `APP_DOMAIN` to the hostname only, such as `loans.example.co.tz`. The frontend/API origin is derived from that hostname. Generate distinct database and JWT secrets with `openssl rand -hex 32`. Fill in the initial administrator username, name, and a unique password of at least 12 characters. Keep `.env` private (`chmod 600 .env`) and out of source control.
2. Build the images and start PostgreSQL:

   ```sh
   docker compose build
   docker compose up -d db
   ```

3. Apply the schema and create the first administrator once:

   ```sh
   docker compose --profile setup run --rm db-setup
   ```

   The new administrator must change the initial password on first sign-in. Remove the three `BML_BOOTSTRAP_ADMIN_*` values from `.env` after setup. Re-running setup applies the idempotent schema and will not reset the password of an existing administrator.

4. Start the API, frontend, and HTTPS proxy:

   ```sh
   docker compose up -d backend frontend caddy
   ```

5. Check `https://APP_DOMAIN/api/health/ready`, then sign in and confirm staff approval and customer registration. Configure payment and SMS credentials only when the corresponding provider accounts and callback settings are ready.

Email verification and password reset require an SMTP account. Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `EMAIL_FROM` in `.env` using the credentials and an authorized sender address from your mail provider. Port 587 normally uses `SMTP_SECURE=false`; port 465 normally uses `SMTP_SECURE=true`. Recreate the backend after changing these settings. Registration and self-service password reset remain unavailable until SMTP is configured.

Caddy terminates HTTPS and the frontend Nginx container forwards `/api/*` to the private backend. The API and database have no host-published ports in production. The SPA build uses same-origin API calls; local demo authentication is explicitly disabled in the production image.

### Configuration

`DB_ADMIN_PASSWORD` protects PostgreSQL's initialization account. `DB_PASSWORD` is the separate application database password. Use hexadecimal generated values so the URL-encoded `DATABASE_URL` in Compose remains valid. Never reuse `JWT_SECRET` for either password.

Snippe handles customer mobile money repayments and loan payouts. Set `SNIPPE_BASE_URL` to the Snippe API URL, then provide `SNIPPE_API_KEY`, `SNIPPE_WEBHOOK_SECRET`, and the public HTTPS callback `SNIPPE_WEBHOOK_URL=https://APP_DOMAIN/api/webhooks/snippe`. Provider payments stay disabled until all four settings are configured. Keep provider secrets in the backend environment; never add them to `VITE_*` variables. Beem credentials and an approved sender ID are required for SMS.

## Local development

The development Compose file is isolated from the production database volume:

```sh
docker compose -f docker-compose.dev.yml up --build -d
docker compose -f docker-compose.dev.yml exec backend npm run db:setup
```

The frontend is at `http://localhost:5173` and the API at `http://localhost:4000`. For a blank database, set the three `BML_BOOTSTRAP_ADMIN_*` variables in the root `.env` before running setup. Never put production customer data or provider credentials in the development stack.

## Schema updates

Schema updates are not run during API startup. Back up the database first, build the new backend image, then run the setup job before starting the updated API:

```sh
docker compose --profile setup run --rm db-setup
docker compose up -d backend frontend caddy
```

The schema is designed for additive, repeatable updates. Review the schema diff and test migrations against a restored backup before applying changes to a production database.

The new Compose setup creates a fresh named database volume. If you already have loans or customer data in the earlier local volume (`brianna_lms_db_v2`), do not point users at the new stack expecting data to appear automatically. Take and verify a dump from the old database, restore it into the new database as `bml_app` without the old owner/ACL metadata, then run schema setup before directing traffic to the new host.

## Backups and operations

The Compose database volume persists across container replacement; it is not a backup. Schedule encrypted PostgreSQL dumps to independent storage and periodically test restoring one. A manual dump can be made with:

```sh
docker compose exec -T db pg_dump -U bml_app -d bml_lms > bml_lms-backup.sql
```

Inspect service health and recent logs with `docker compose ps` and `docker compose logs --tail=200 backend caddy`. Keep host, Docker, and PostgreSQL security updates current. Restrict host SSH and database administration access to trusted operators.

The application currently provides rate limits and password-change-on-first-login for the bootstrap admin, but it does not provide multi-factor authentication. Decide whether BML policy requires MFA before granting staff production accounts.

The images use the current Node.js 24 LTS and Nginx stable release lines; keep them updated and rebuild regularly as security fixes are published.

## Build checks

Run `npm ci && npm run build` in both `backend/` and `frontend/`. Automated business-flow, provider sandbox, migration restore, and production browser checks are still required before the first live-money launch.
