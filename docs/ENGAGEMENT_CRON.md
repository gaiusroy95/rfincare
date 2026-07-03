# Engagement notification cron

Automated in-app reminders for abandoned insurance checkouts, abandoned MF SIP orders, and insurance renewal due dates.

## Manual run

```bash
cd backend
npm run engagement:run
```

Optional env: `ENGAGEMENT_BATCH_LIMIT` (default 50, max 200).

## Render cron (recommended)

1. Set `ENGAGEMENT_CRON_SECRET` on the backend service (long random string).
2. Create a **Cron Job** on Render that runs every 6 hours:

```bash
curl -fsS -H "X-Engagement-Cron-Secret: $ENGAGEMENT_CRON_SECRET" \
  "https://YOUR-API.onrender.com/engagement/cron/run?limit=50"
```

3. Or use the npm script on a Render cron worker with database access.

## Admin trigger

`POST /engagement/run-notifications` (authenticated admin) remains available for manual runs.
