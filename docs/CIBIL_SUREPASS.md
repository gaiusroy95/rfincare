# Surepass CIBIL / Experian PDF Report

Rfincare pulls credit score + PDF through Surepass.

- **TransUnion CIBIL** (customer first pull, guest fallback): `/api/v1/credit-cibil-pdf-report`
- **Experian** (customer refresh + **homepage guest preferred**): `/api/v1/credit-experian-pdf-report`

Console (TransUnion): https://console.surepass.app/product/console/api/credit-cibil-pdf-report

## Env (backend/.env)

```env
SUREPASS_BASE_URL=https://kyc-api.surepass.io
SUREPASS_CIBIL_PATH=/api/v1/credit-cibil-pdf-report
SUREPASS_EXPERIAN_PATH=/api/v1/credit-experian-pdf-report
SUREPASS_SANDBOX=true
SUREPASS_TOKEN=
SUREPASS_ID_NUMBER=
SUREPASS_PASSWORD=
```

Use **either**:

1. `SUREPASS_TOKEN` — Bearer token from the Surepass console, or  
2. `SUREPASS_ID_NUMBER` + `SUREPASS_PASSWORD` — Surepass login (email or mobile).

Optional TRAI consent annexure (homepage form → `consent_evidence`):

```env
CONSENT_TM_NAME=
CONSENT_TM_ID=
CONSENT_DLT_RECORD=
```

If `CONSENT_DLT_RECORD` is unset, the API stores `MSG91_SENDER_ID` + OTP template id as the DLT reference when available.

On API start, TransUnion CIBIL is marked **active** and Experian is kept available by key. Homepage `POST /public/cibil/check` tries **Experian first**, then soft-falls back to TransUnion. Sandbox without credentials still returns a local stub PDF so homepage/customer checks keep working. Production mode (`SUREPASS_SANDBOX=false` and vendor sandbox off) requires real credentials.

## Where it is used

- Homepage “Check free CIBIL score” → `POST /public/cibil/check` (OTP required; returns `creditScore` + `pdfUrl` / `reportUrl`)
- Customer dashboard “Check CIBIL Score”
- Loan application submit (bureau check)
- Admin Milestone 4 sandbox pull + employee PDF download

## Consent evidence

OTP-verified homepage submits write a row to `consent_evidence` (auto-created on first use) with TRAI fields: consent wording, date/time, source `website/homepage_cibil`, masked customer number, product/purpose, lead relationship, TM/DLT details.

## Restart

Restart the API after filling credentials. Redeploy with the same env vars (including `SUREPASS_EXPERIAN_PATH` on hosts that sync `deployment/backend/dist`).
