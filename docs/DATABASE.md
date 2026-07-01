# Database (PostgreSQL)

Rfincare uses **PostgreSQL** only. Set `DATABASE_URL` in `backend/.env`.

## Local development

```bash
docker compose up postgres -d
cd backend
cp .env.example .env
npm run db:migrate
npm run seed:admin
npm start
```

Example connection string:

```env
DATABASE_URL=postgresql://rfincare:rfincare@127.0.0.1:5432/rfincare
```

## Production (Neon)

Copy the connection string from Neon Dashboard → Connect:

```env
DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require
```

## Migrations

Schema files live in `backend/migrations/postgres/`.

```bash
cd backend
npm run db:migrate
```

This applies any pending `.sql` files and records them in `schema_migrations`.

## Health check

`GET /health` returns `database.engine: postgresql` when `DATABASE_URL` is configured.

## SQL conventions in this codebase

- Named parameters: `:paramName` (converted to `$1`, `$2`, … by the pool)
- Upserts: `ON CONFLICT (…) DO UPDATE SET col = EXCLUDED.col`
- Booleans: `TRUE` / `FALSE` (not `0` / `1`)
- Timestamps: `TIMESTAMPTZ`, `NOW()`, `CURRENT_TIMESTAMP`
- JSON columns: `data->>'field'` for text extraction
