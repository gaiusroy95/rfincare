# Scheduled report email cron

Generates scheduled report CSVs and emails them to the recipients saved in **Reports & Analytics → Schedule**.

## Requirements

1. **SMTP** on the API host (Render often blocks outbound SMTP — use a provider that allows it, or a relay):

```env
SMTP_HOST=...
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM=noreply@yourdomain.com
```

2. **Cron secret** (reuse engagement secret or set a dedicated one):

```env
REPORTS_CRON_SECRET=long-random-string
# or ENGAGEMENT_CRON_SECRET=...
```

## Manual run

```bash
cd backend
npm run reports:run
```

Force every active schedule (ignore due window):

```bash
REPORTS_FORCE_ALL=1 npm run reports:run
```

## Render cron (recommended)

Hit the API about **once per hour** so daily/weekly times (IST) are covered:

```bash
curl -fsS -H "X-Reports-Cron-Secret: $REPORTS_CRON_SECRET" \
  "https://YOUR-API.onrender.com/reports/cron/run?limit=50"
```

## Behaviour

- Creating a schedule with **Automatically send report** on sends the first email immediately.
- Recurring runs update `report_schedules.last_run_at` after a successful send.
- Due checks use **Asia/Kolkata** and the saved `time` / `dayOfWeek` / `dayOfMonth` in `filters_json`.
- Attachments are CSV (Excel-compatible).

## Manual re-send (authenticated)

`POST /reports/schedules/:id/run`
