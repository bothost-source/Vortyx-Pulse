# Vortyx Pulse — Backend

Node/Express + PostgreSQL backend for Vortyx Pulse: Google sign-in, API key
management (with the free-tier 5-key limit), card + crypto payments with
manual admin confirmation, the admin console API, and the public `/v1` AI
API that your users' own apps will call.

## 1. Local setup

```bash
npm install
cp .env.example .env   # fill in real values, see below
npm run migrate        # creates all tables in your Postgres database
npm start
```

Server runs on `http://localhost:3000` by default.

## 2. Environment variables (`.env`)

| Variable | Where to get it |
|---|---|
| `DATABASE_URL` | Supabase project → Settings → Database → Connection string (use the pooler URL, port 6543) |
| `JWT_SECRET` | Any long random string (e.g. `openssl rand -hex 32`) |
| `GOOGLE_CLIENT_ID` | Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID (Web application) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Only needed once you wire up real Stripe in `routes/payments.js` |
| `MODEL_ENDPOINT` | Your Hugging Face Space URL + `/v1/chat/completions` |
| `MODEL_API_KEY` | The `INTERNAL_SECRET` you set as a secret on your Hugging Face Space |

## 2b. Moving from Render Postgres to Supabase

1. Go to supabase.com → create a free project (takes ~2 minutes to provision).
2. Once it's ready: Settings → Database → Connection string → copy the
   **Transaction pooler** string (port `6543`) — this works better on
   Render/most PaaS hosts than the direct connection string.
3. Replace `DATABASE_URL` in `.env` (or your Render environment variables)
   with that string, filling in your database password.
4. This is a fresh database — since your old Render Postgres already
   expired, there's no data to migrate. `npm run migrate` (or the app's
   normal startup, which runs migrations automatically) will create all
   tables fresh on Supabase.

## 3. Google Sign-In setup

1. Go to console.cloud.google.com → create/select a project.
2. APIs & Services → OAuth consent screen → set it up (External, add your email as a test user while in development).
3. APIs & Services → Credentials → Create Credentials → OAuth Client ID → Web application.
4. Under "Authorized JavaScript origins" add your deployed frontend URL (e.g. `https://vortyxpulse.onrender.com` or your custom domain, plus `http://localhost` for local testing).
5. Copy the Client ID into `.env` as `GOOGLE_CLIENT_ID`, and also into `login.html` (the `GOOGLE_CLIENT_ID` constant near the bottom of the file).

No OTP, no password — Google verifies the person, and this backend just
finds-or-creates their Vortyx Pulse account by their Google email.

## 4. Making yourself admin

There's no signup flow for admins — sign in normally with Google once,
then run this against your database (Render's Postgres has a built-in
SQL shell, or use any Postgres client):

```sql
UPDATE users SET is_admin = TRUE WHERE email = 'you@yourcompany.com';
```

## 5. Deploying to Render

1. Push this folder to a GitHub repo.
2. Render → New → Web Service → connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add all the environment variables from step 2 in Render's dashboard.
5. Create a Render Postgres instance (New → PostgreSQL), copy its internal
   connection string into `DATABASE_URL`.
6. After first deploy, run the migration once — easiest way is Render's
   Shell tab on the service: `npm run migrate`.

## 6. Connecting the frontend

In `login.html`, `vortyx-pulse-dashboard.html`, and `vortyx-pulse-admin.html`,
set the `API_BASE` constant near the top of the `<script>` to your deployed
Render backend URL, e.g.:

```js
const API_BASE = "https://vortyx-pulse-backend.onrender.com";
```

## 7. The model connection, token quotas, and rate limits

`callModel()` in `routes/v1.js` now calls your real Hugging Face Space
(set via `MODEL_ENDPOINT` / `MODEL_API_KEY`), instead of echoing input back.

Every request to `/v1/chat` goes through, in order: API key auth → plan
expiry check → rate limit → monthly token quota → the model itself. A
request that fails any check is rejected before it ever reaches the model,
with a clear error message telling the user why.

Plan limits (requests/minute and monthly token quota) live in one place:
`config/plans.js`. Change the numbers there — nothing else needs touching.
Currently:

| Plan | Monthly tokens | Requests / minute |
|---|---|---|
| Free | 50,000 | 8 |
| 3-Month | 2,000,000 | 60 |
| Annual | 2,000,000 | 60 |
| Permanent | Unlimited | 120 |

Rate limiting is in-memory (per running server instance) — fine for a
single-instance deployment. Token quotas are stored in the database
(`users.tokens_used_this_period`, resetting every 30 days via
`users.period_reset_at`) so they persist across restarts and deploys.

Audio and video modalities return a clear "not available yet" response
rather than pretending to work — wire those up in `callModel()`/the two
route handlers once you have a model that supports them.

## Folder structure

```
server.js              entry point, wires up all routes
config/plans.js         per-plan token quota + rate limit numbers
db/schema.sql           run once to create tables
db/pool.js               Postgres connection (Supabase, SSL required)
middleware/auth.js      JWT session verification + plan-expiry check
routes/auth.js          Google sign-in, /me
routes/keys.js          API key create/list/revoke (free tier limit enforced)
routes/payments.js      card (Stripe stub) + crypto payment submission
routes/admin.js         stats, payment confirm/reject, users, reports, key revoke
routes/usage.js          real per-user request stats
routes/reports.js        user-submitted issue reports
routes/v1.js             the public AI API your users' apps call — real model, quotas, rate limits
```
