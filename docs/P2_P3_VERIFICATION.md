# P2/P3 verification checklist

## Automated

```bash
cd backend && npm test
cd frontend && npm test
cd frontend && npm run build
cd backend && npm run db:migrate
```

## Manual flows

| # | Flow | Actor | Expected |
|---|------|-------|----------|
| 1 | Guest compare on insurance/MF, refresh | Guest | Resume banner restores selection |
| 2 | Post office / govt / investment compare refresh | Guest | Compare basket restored |
| 3 | Govt scheme Apply / Enquire | Guest | Lead wizard → lead created |
| 4 | Investment calculator Apply | Guest | Wizard + lead with calculator context |
| 5 | Employee Leads tab | employee@rfincare.com | Only assigned leads |
| 6 | Agent commission after SIP active | Agent + customer | Ledger row + dashboard breakdown |
| 7 | Agent commission after insurance paid | Agent + customer | Ledger row in agent dashboard |
| 8 | Admin funnel → Agent attribution | Admin | Agent leads, insurance paid, SIP active counts |
| 9 | Mobile credit pull | customer mobile | Bureau score on dashboard |
| 10 | Mobile SIP with `?agent=` | Guest/customer | SIP order with agent code |
| 11 | CIBIL pull (web) | customer@rfincare.com | CreditScoreCard updates |

## Demo credentials

- Customer: `customer@rfincare.com` / `Customer@2026`
- Agent: `agent@rfincare.com` / `Agent@2026`
- Employee: `employee@rfincare.com` / `Employee@2026`
