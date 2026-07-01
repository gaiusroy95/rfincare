# MySQL → PostgreSQL data migration

Move existing production data from MySQL into Neon PostgreSQL without losing records.

## Overview

| Step | What |
|------|------|
| 1 | Keep MySQL running with your live data |
| 2 | Apply Postgres **schema** on Neon (`npm run db:migrate:postgres`) |
| 3 | Copy **data** with the migration script |
| 4 | Point API at Postgres (`DATABASE_URL`) and verify |
| 5 | Decommission MySQL when satisfied |

**Files on disk** (`backend/uploads/`) are separate — copy them to S3/object storage if you use cloud storage.

---

## Prerequisites

In `backend/.env` you need **both** connections during migration:

```env
# Source (existing data)
MYSQL_HOST=...
MYSQL_USER=...
MYSQL_PASSWORD=...
MYSQL_DATABASE=...

# Target (Neon)
DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require
```

Postgres schema must already exist:

```bash
cd backend
npm run db:migrate:postgres
```

---

## Recommended workflow

### 1. Dry run (safe — no writes)

See how many rows would be copied:

```bash
npm run db:migrate:data:dry
```

### 2. First copy (keeps existing Postgres seed rows)

Skips tables that already have data in Postgres (e.g. after `seed:admin`):

```bash
npm run db:migrate:data
```

### 3. Full refresh (replace all Postgres data from MySQL)

Use when Neon was empty or you want a clean overwrite:

```bash
npm run db:migrate:data:full
```

This runs `--truncate` then copies every table.

### 4. Copy specific tables only

```bash
node scripts/mysql-to-postgres-data.mjs --tables=loan_applications,customer_documents,user_profiles
```

### 5. Verify

```bash
npm start
curl http://localhost:8080/health
```

Log in on the website with an existing customer/admin account from MySQL.

Compare row counts:

```bash
# MySQL
mysql -h HOST -u USER -p DATABASE -e "SELECT COUNT(*) FROM loan_applications;"

# Or use dry-run output for all tables
npm run db:migrate:data:dry
```

---

## What the script does

- Reads every table that exists in **both** MySQL and Postgres
- Copies tables in **foreign-key order** (parents before children) — works on Neon without superuser privileges
- Converts MySQL types → Postgres:
  - `TINYINT(1)` → `boolean`
  - `JSON` → `jsonb`
  - timestamps pass through
- Inserts in batches of 500 rows
- Skips `schema_migrations` (Postgres-only)
- Default: **skip** tables that already have rows in Postgres (`--truncate` or `--force` to override)

---

## Cutover checklist (production)

1. **Maintenance window** (optional) — stop writes or put app in read-only mode
2. **Final MySQL backup** — mysqldump or provider snapshot
3. **Run migrations on Neon** if schema changed: `npm run db:migrate:postgres`
4. **Copy data**: `npm run db:migrate:data:full`
5. **Update Render/host env** — set `DATABASE_URL`, remove or comment `MYSQL_*`
6. **Restart API**
7. **Smoke test** — login, loan application, document upload, admin dashboard
8. **Keep MySQL read-only** for 1–2 weeks as rollback safety net

---

## Alternative: manual export/import

For very large databases or DBA-managed moves:

### Option A — `pgloader` (popular)

```bash
pgloader mysql://user:pass@host/rfincare postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require
```

Install: https://pgloader.io/

### Option B — CSV per table

1. Export from MySQL: `SELECT * INTO OUTFILE` or MySQL Workbench / phpMyAdmin export
2. Import to Neon via `\copy` in `psql` or Neon SQL editor
3. Tedious for many tables — use the script above instead

### Option C — mysqldump + transform

Not recommended for this project — schema differs (MySQL vs converted Postgres DDL).

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `relation does not exist` on Postgres | Run `npm run db:migrate:postgres` first |
| Table skipped — “already has rows” | Use `npm run db:migrate:data:full` or `--force` |
| Duplicate key errors | Use `--truncate` for a clean copy |
| Missing columns | MySQL-only column ignored; run latest Postgres migrations |
| Passwords don’t work | `auth_users.password_hash` is copied as-is — should work if bcrypt |

---

## After migration

Update `seed-admin.js` / ops scripts to use `getPool()` from `src/db/pool.js` so they work with Postgres only.

Set production env:

```env
DATABASE_URL=postgresql://...
DB_PROVIDER=postgres
# MYSQL_* no longer needed
```
