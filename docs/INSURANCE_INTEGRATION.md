# Insurance purchase integration

On-site insurance checkout uses insurer provider configs (`insurance_insurer_providers`) with an `integration_mode`:

| Mode | Behaviour |
|------|-----------|
| `demo` | Sandbox quote/proposal/payment — **no real policy**. UI shows a sandbox banner. |
| `generic_api` | REST adapter to insurer/aggregator (requires `base_url`, `api_key`, `api_secret`). |

## Production checklist

1. Admin → Insurance → Providers: set `integration_mode` to `generic_api` and configure live credentials.
2. Set `purchase_enabled` on products that should support on-site checkout.
3. Configure webhook URL for payment callbacks (see `insuranceWebhooks` routes).
4. Redeploy backend after env or provider changes.

## Customer-facing indicators

- Purchase status API (`GET /insurance-purchases/:id?token=`) returns `isDemo` and `integrationMode`.
- Marketplace and purchase modal display a sandbox banner when `isDemo === true`.

## Environment variables

- Standard database and app URL vars (see `DATABASE.md`).
- `PUBLIC_APP_URL` / `FRONTEND_URL` — used for payment return URLs.
