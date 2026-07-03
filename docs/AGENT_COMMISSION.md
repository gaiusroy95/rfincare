# Agent commission (non-loan products)

## Overview

Agent commission accrues from:

| Source | `source_type` | `product_type` config key | Trigger |
|--------|---------------|---------------------------|---------|
| Loan application | (computed live) | `personal_loan`, `home_loan`, etc. | Application approved |
| Insurance purchase | `insurance_purchase` | `insurance` | `payment_status = paid` |
| MF SIP | `mf_sip` | `mutual_fund_sip` | SIP `status = active` |

Non-loan commissions are stored in `agent_commission_ledger` (migration `053_agent_product_commission.sql`).

## Configuration

`agent_commission_config.loan_type` accepts product slugs:

- Loan types: `home_loan`, `personal_loan`, …
- `insurance`
- `mutual_funds`
- `mutual_fund_sip`
- `post_office`, `government_scheme`, `investment`

Import via Admin commission CSV with `loan_type` column set to the product slug.

## Commission calculation

- **Percentage:** `round(base_amount × commission_value / 100)`
- **Fixed:** `round(commission_value)`
- **Insurance base:** `payment_amount` (premium)
- **SIP base:** first-year volume = `sip_amount × 12`

Ledger inserts are idempotent on `(source_type, source_id)`.

## Agent dashboard

`GET /portal/agent/dashboard` returns:

- `commissionEntries` — loans + ledger rows merged
- `commissionSummary.breakdown` — `{ loans, insurance, sip }`

## Attribution

Insurance orders store `sourced_agent_code` at checkout. SIP orders already store it from Phase C. Frontend/mobile pass `sourcedAgentCode` via agent URL `?agent=CODE`.
