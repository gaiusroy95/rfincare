# Surepass CIBIL PDF Report

Rfincare pulls TransUnion CIBIL score + PDF through Surepass.

Console: https://console.surepass.app/product/console/api/credit-cibil-pdf-report

## Env (backend/.env)

```env
SUREPASS_BASE_URL=https://kyc-api.surepass.io
SUREPASS_CIBIL_PATH=/api/v1/credit-cibil-pdf-report
SUREPASS_SANDBOX=true
SUREPASS_TOKEN=
SUREPASS_ID_NUMBER=
SUREPASS_PASSWORD=
```

Use **either**:

1. `SUREPASS_TOKEN` — Bearer token from the Surepass console, or  
2. `SUREPASS_ID_NUMBER` + `SUREPASS_PASSWORD` — Surepass login (email or mobile).

On API start, TransUnion CIBIL is marked **active**. Sandbox without credentials still returns a local stub PDF so homepage/customer checks keep working. Production mode (`SUREPASS_SANDBOX=false` and vendor sandbox off) requires real credentials.

## Where it is used

- Homepage “Check free CIBIL score” → `POST /public/cibil/check`
- Customer dashboard “Check CIBIL Score”
- Loan application submit (bureau check)
- Admin Milestone 4 sandbox pull + employee PDF download

## Restart

Restart the API after filling credentials. Redeploy Render with the same env vars.
