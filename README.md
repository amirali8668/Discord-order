# Discord Bot — Railway Deployment

This folder contains the **Railway** (Node.js / PostgreSQL) version of the M+ Discord Bot.  
The original Cloudflare Workers version remains untouched in the repository root.

---

## Architecture

| Component | Railway version |
|-----------|----------------|
| Runtime | Node.js 20 + Express |
| Database | PostgreSQL (Railway managed) |
| KV store | `kv_store` table in PostgreSQL |
| Channel discovery | `setInterval` scheduler (replaces DO Alarm) |
| WebSocket | `ws` library |
| Sessions | `connect-pg-simple` PostgreSQL session store |

---

## Local test

```bash
cd railway
npm install
cp .env.example .env
# Fill in .env with real values
npm run dev
```

Open `http://localhost:3000` for the admin panel.

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | PostgreSQL connection string (Railway provides this automatically) |
| `DISCORD_TOKEN` | ✅ | Main Discord token — ACTION operations (send messages) |
| `DISCORD_READ_TOKEN` | ✅ | Read-only Discord token — READ operations (discovery) |
| `PANEL_PASSWORD` | ✅ | Admin panel login password |
| `SESSION_SECRET` | ✅ | Random 32+ char string for session signing |
| `DISCORD_PUBLIC_KEY` | optional | Discord app public key for gateway webhook signature |
| `TELEGRAM_TOKEN` | optional | Telegram bot token for alerts |
| `TRUST_PROXY` | `1` on Railway | Set to `1` so secure cookies work behind Railway HTTPS |
| `PORT` | auto | Railway injects this — do NOT set manually on Railway |
| `NODE_ENV` | `production` | Set to `production` on Railway |

---

## GitHub → Railway deployment

### One-time setup

1. **Push to GitHub**
   ```bash
   git add .
   git commit -m "Add Railway version"
   git push origin main
   ```

2. **Create Railway project**
   - Go to [railway.app](https://railway.app)
   - Click **New Project → Deploy from GitHub repo**
   - Authorise GitHub and select your repository

3. **Add PostgreSQL service**
   - In your Railway project: **New → Database → Add PostgreSQL**
   - Railway will automatically set `DATABASE_URL` for your service

4. **Configure the service**
   - Go to your web service → **Settings → Source**
   - Set **Root Directory** to `railway`
   - Railway will use `railway.toml` for build/start commands

5. **Set environment variables**
   - Go to your service → **Variables**
   - Add all required variables from the table above
   - Railway sets `DATABASE_URL` and `PORT` automatically

6. **Deploy**
   - Click **Deploy** or push a new commit
   - Railway will build the Docker image and deploy

7. **Generate public domain**
   - Go to your service → **Settings → Networking**
   - Click **Generate Domain**
   - Your app will be available at `https://yourapp.up.railway.app`

---

## Healthcheck

Railway uses `/health` for deployment health checks.

```
GET /health → 200 OK
{"status":"ok",...}
```

---

## Automatic deployments

Every push to the connected GitHub branch triggers:
1. Docker build
2. New deployment
3. Health check
4. Traffic switch if healthy

No manual steps required after initial setup.

---

## PORT

Railway injects `PORT` automatically.  
The app listens on `0.0.0.0:$PORT`.  
**Do not set PORT manually in Railway variables.**

---

## Database migrations

Migrations run automatically on startup from `railway/migrations/001_initial.sql`.  
They use `CREATE TABLE IF NOT EXISTS` so they are safe to run multiple times.
