# Money Intx — Deployment Guide (Vercel + Neon + Resend)

All three services have free tiers. No credit card needed to start.

---

## Step 1 — Set up the database (Neon)

1. Go to **https://neon.tech** → Sign up free
2. Create a new project (name it `monney-intx` or anything you like)
3. In the project dashboard, click **SQL Editor**
4. Paste the entire contents of `schema.sql` and click **Run**
5. Go to **Connection Details** → copy the **Connection string** (starts with `postgresql://...`)
   - Keep this — you'll need it in Step 3

---

## Step 2 — Set up email (Resend)

1. Go to **https://resend.com** → Sign up free (3,000 emails/month free)
2. Go to **API Keys** → Create API key → copy it
3. (Optional) Add and verify your domain in Resend for branded `From` addresses.
   Until then, emails send from `onboarding@resend.dev` which is fine for testing.

---

## Step 3 — Deploy to Vercel

1. Go to **https://vercel.com** → Sign up / log in with GitHub
2. Click **Add New Project** → Import your GitHub repo
   - If you haven't pushed to GitHub yet: create a repo, push your `Monney Intx` folder
3. Vercel will auto-detect the project. Leave all build settings as default.
4. Before clicking Deploy, click **Environment Variables** and add:

| Variable         | Value                                      |
|------------------|--------------------------------------------|
| `DATABASE_URL`   | Your Neon connection string from Step 1    |
| `JWT_SECRET`     | Any long random string (e.g. 64 random chars) |
| `RESEND_API_KEY` | Your Resend API key from Step 2            |
| `APP_URL`        | Your Vercel URL (e.g. `https://monney-intx.vercel.app`) |
| `EMAIL_FROM`     | `Money Intx <noreply@yourdomain.com>` or leave blank for default |

5. Click **Deploy**. Done.

---

## Step 4 — Create your real admin account

After deploying, go to your live URL and click **Sign Up** to create your real account.

To make yourself admin, run this in the Neon SQL Editor:
```sql
UPDATE users SET role = 'admin' WHERE email = 'your@email.com';
```

---

## Generating a JWT_SECRET

Run this in your terminal to generate a secure secret:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

---

## Local development (without a server)

Open `index.html` directly in your browser (`file://`). The app detects it's running
locally and falls back to localStorage automatically. Full functionality works locally
except email sending.

---

## File structure

```
Monney Intx/
├── index.html          ← Frontend (single file)
├── vercel.json         ← Vercel routing config
├── package.json        ← Node dependencies
├── schema.sql          ← Run once in Neon SQL Editor
├── DEPLOY.md           ← This file
├── lib/
│   ├── db.js           ← Neon database connection
│   ├── auth.js         ← JWT + bcrypt helpers
│   └── email.js        ← Resend email sender
└── api/
    ├── auth/
    │   ├── signup.js         POST /api/auth/signup
    │   ├── login.js          POST /api/auth/login
    │   ├── logout.js         POST /api/auth/logout
    │   ├── session.js        GET  /api/auth/session
    │   ├── reset-request.js  POST /api/auth/reset-request
    │   └── reset-confirm.js  POST /api/auth/reset-confirm
    ├── data/
    │   ├── load.js           GET  /api/data/load
    │   └── sync.js           POST /api/data/sync
    └── email/
        ├── send-invoice.js   POST /api/email/send-invoice
        └── send-reminder.js  POST /api/email/send-reminder
```

---

## How data persistence works

Each user's data is stored as a single encrypted JSON blob in Neon (`user_data` table).

- Every `save()` in the app pushes to `/api/data/sync` (debounced 800ms)
- Every login pulls from `/api/data/load`
- localStorage is kept as an offline cache

This means your data survives even if you clear the browser — it lives on the server.

Later, individual collections (contacts, entries, templates) can be moved to their own
normalized tables without touching the frontend at all.

---

## Environment variables summary

| Variable         | Required | Description                              |
|------------------|----------|------------------------------------------|
| `DATABASE_URL`   | ✅       | Neon PostgreSQL connection string        |
| `JWT_SECRET`     | ✅       | Secret for signing session tokens        |
| `RESEND_API_KEY` | ✅       | Resend API key for transactional email   |
| `APP_URL`        | Recommended | Your full app URL (for password reset links) |
| `EMAIL_FROM`     | Optional | Custom From address for emails           |
| `JWT_EXPIRES`    | Optional | Token lifetime, default `30d`            |
