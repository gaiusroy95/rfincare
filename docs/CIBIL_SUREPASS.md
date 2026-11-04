# Surepass CIBIL / Experian PDF Report

Rfincare pulls credit score + PDF through Surepass.

- **TransUnion CIBIL** (employee/admin): `/api/v1/credit-report-cibil/fetch-report-pdf`
- **Experian** (homepage + customer/agent): `/api/v1/credit-report-experian/fetch-report-pdf`

## Env (backend/.env)

```env
# Production (real bureau scores)
SUREPASS_BASE_URL=https://kyc-api.surepass.io
SUREPASS_CIBIL_PATH=/api/v1/credit-report-cibil/fetch-report-pdf
SUREPASS_EXPERIAN_PATH=/api/v1/credit-report-experian/fetch-report-pdf
SUREPASS_SANDBOX=false
SUREPASS_TIMEOUT_MS=60000
SUREPASS_TOKEN=<production token from the Surepass console>
SUREPASS_ID_NUMBER=
SUREPASS_PASSWORD=
```

The API host follows the token: a production token always calls `https://kyc-api.surepass.io`, a sandbox token (identity starting with `dev.`) always calls `https://sandbox.surepass.io`, so a mismatched `SUREPASS_BASE_URL` cannot cause 401s. Sandbox tokens only return Surepass demo data, never a person's real score. Admin → CIBIL vendors shows the detected token environment and expiry.

Use **either**:

1. `SUREPASS_TOKEN` — Bearer token from the Surepass console, or  
2. `SUREPASS_ID_NUMBER` + `SUREPASS_PASSWORD` — Surepass login (email or mobile).

Legacy paths (`/api/v1/credit-cibil-pdf-report`, `/api/v1/credit-experian-pdf-report`) are ignored; the code falls back to the `fetch-report-pdf` endpoints above.

Optional TRAI consent annexure (homepage form → `consent_evidence`):

```env
CONSENT_TM_NAME=
CONSENT_TM_ID=
CONSENT_DLT_RECORD=
```

If `CONSENT_DLT_RECORD` is unset, the API stores `MSG91_SENDER_ID` + OTP template id as the DLT reference when available.

On API start, TransUnion CIBIL is marked **active** and Experian is kept available by key. Homepage `POST /public/cibil/check` uses **Experian**. Sandbox without credentials may return a local stub PDF. Production mode (`SUREPASS_SANDBOX=false` and vendor sandbox off) requires a live paid token.

## Where it is used

- Homepage “Check free CIBIL score” → `POST /public/cibil/check` (OTP required; returns `creditScore` + `pdfUrl` / `reportUrl`)
- Customer / agent dashboard credit score (Experian)
- Employee / admin portal CIBIL check (TransUnion)
- Loan application submit (bureau check)

## Consent evidence

OTP-verified homepage submits write a row to `consent_evidence` (auto-created on first use) with TRAI fields: consent wording, date/time, source `website/homepage_cibil`, masked customer number, product/purpose, lead relationship, TM/DLT details.

## Restart

Restart the API after filling credentials. Redeploy Render with the same env vars (including `SUREPASS_EXPERIAN_PATH` and the correct `fetch-report-pdf` paths).
