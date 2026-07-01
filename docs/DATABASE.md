# Database — Neon PostgreSQL

Rfincare supports **Neon PostgreSQL** via `DATABASE_URL`, or **MySQL** via `MYSQL_*` variables.

## Neon setup (recommended)

### 1. Create a Neon project

1. Go to [https://neon.tech](https://neon.tech) and create a project.
2. Open **Dashboard → Connect**.
3. Copy the **connection string** (pooled recommended for serverless/API):

```
postgresql://user:password@ep-xxxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
```

### 2. Configure the API

In `backend/.env`:

```env
# PostgreSQL on Neon — DATABASE_URL alone is enough
DATABASE_URL=postgresql://user:password@ep-xxxx.region.aws.neon.tech/neondb?sslmode=require

# Optional explicit provider (auto-detected when DATABASE_URL is set)
DB_PROVIDER=postgres
```

Remove or comment out `MYSQL_*` when using Neon so there is no confusion.

On **Render** / **Vercel** (API host): add `DATABASE_URL` as an environment variable in the dashboard.

### 3. Run migrations

From `backend/`:

```bash
npm run db:migrate:postgres
```

This applies SQL files in `migrations/postgres/` and records them in `schema_migrations`.

### 4. Seed admin user

```bash
npm run seed:admin
```

(Uses the same `getPool()` — works with Neon once migrations are applied.)

### 5. Verify

```bash
curl http://localhost:8080/health
```

Expect:

```json
{
  "ok": true,
  "architecture": {
    "database": {
      "provider": "postgres",
      "engine": "postgresql",
      "configured": true
    }
  }
}
```

---

## MySQL (local / legacy)

```env
DB_PROVIDER=mysql
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=rfincare
MYSQL_PASSWORD=rfincare
MYSQL_DATABASE=rfincare
```

```bash
docker compose up mysql -d
npm run db:migrate
```

---

## How provider is chosen

| Condition | Database |
|-----------|----------|
| `DATABASE_URL` is set | PostgreSQL (Neon) |
| `DB_PROVIDER=postgres` | PostgreSQL (requires `DATABASE_URL`) |
| `DB_PROVIDER=mysql` | MySQL (requires `MYSQL_*`) |
| Neither | MySQL (default) |

---

## Regenerating Postgres migrations

When MySQL migrations in `migrations/` change:

```bash
npm run db:convert:postgres
npm run db:migrate:postgres
```

---

## Notes

- **SSL:** Neon requires SSL. Enabled by default; set `DATABASE_SSL=false` only for local Postgres without TLS.
- **SQL compatibility:** Route handlers use a Postgres adapter that converts MySQL-style `:named` parameters and common `COLLATE` / `CONVERT` patterns. Report any query errors after switching.
- **Indexes:** Some MySQL `KEY` definitions are stripped during conversion; add `CREATE INDEX IF NOT EXISTS` in Postgres migrations if needed.
