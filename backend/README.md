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
| `DATABASE_URL` | Render → your Postgres instance → "Connections" |
| `JWT_SECRET` | Any long random string (e.g. `openssl rand -hex 32`) |
| `GOOGLE_CLIENT_ID` | Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID (Web application) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Only needed once you wire up real Stripe in `routes/payments.js` |
| `MODEL_ENDPOINT` / `MODEL_API_KEY` | Your own model, once ready — used in `routes/v1.js` |

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

## 7. Connecting your real model

Everything about auth, keys, limits, and payments is real and working.
The one deliberate stub is `callModel()` in `routes/v1.js` — replace it
with a real call to whatever you build `vortyx-1` on top of. Nothing else
needs to change; usage logging and plan/key validation already wrap it.

## Folder structure

```
server.js              entry point, wires up all routes
db/schema.sql           run once to create tables
db/pool.js               Postgres connection
middleware/auth.js      JWT session verification + plan-expiry check
routes/auth.js          Google sign-in, /me
routes/keys.js          API key create/list/revoke (free tier limit enforced)
routes/payments.js      card (Stripe stub) + crypto payment submission
routes/admin.js         stats, payment confirm/reject, users, reports, key revoke
routes/usage.js          real per-user request stats
routes/reports.js        user-submitted issue reports
routes/v1.js             the public AI API your users' apps call
```
