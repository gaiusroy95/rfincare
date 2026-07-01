# Rfincare backend (Express + PostgreSQL)

API server, PostgreSQL migrations, and tooling scripts.

## Quick start

1. Copy `backend/.env.example` → `backend/.env`
2. Set `DATABASE_URL`, JWT secrets, `API_PORT`, and `API_CORS_ORIGIN`
3. `docker compose up postgres -d` (optional local database)
4. `cd backend && npm install && npm run db:migrate && npm run seed:admin && npm start`

See `docs/DATABASE.md` for database setup.
