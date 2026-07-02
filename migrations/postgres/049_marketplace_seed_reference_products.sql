-- Reference products for Post Office, Government Schemes, and Investment marketplaces

INSERT INTO post_office_products (
  id, name, slug, description, categories, interest_rate,
  tenure_min_months, tenure_max_months, min_deposit_amount, max_deposit_amount,
  eligibility_text, returns_summary, tax_benefits_text,
  calculator_enabled, calculator_type, compounding_frequency, apply_url, features, highlights, display_priority, status
) VALUES
(
  'po-ppf-001', 'Public Provident Fund (PPF)', 'ppf',
  'Long-term tax-saving instrument backed by Government of India with annual compounding.',
  '["ppf"]'::jsonb, 7.10, 180, 180, 500, 150000,
  'Resident individuals; one account per person; minors via guardian.',
  '7.10% p.a. compounded annually; 15-year lock-in (extendable in blocks of 5 years).',
  'EEE status — deposits, interest and maturity exempt under Section 80C (up to ₹1.5L/year).',
  TRUE, 'ppf', 'annual', 'https://www.indiapost.gov.in/',
  '["15-year tenure","Partial withdrawal after 6th year","Loan facility from 3rd year"]',
  'Most popular long-term post office savings scheme', 100, 'active'
),
(
  'po-nsc-001', 'National Savings Certificate (NSC)', 'nsc',
  'Fixed-income certificate with 5-year tenure and Section 80C benefit.',
  '["nsc"]'::jsonb, 7.70, 60, 60, 1000, NULL,
  'Any resident individual; no maximum investment limit.',
  '7.70% p.a. compounded annually; 5-year lock-in.',
  'Deposit eligible for 80C deduction; interest deemed reinvested and also qualifies for 80C.',
  TRUE, 'nsc', 'annual', 'https://www.indiapost.gov.in/',
  '["5-year lock-in","Transferable to nominee","Low minimum deposit"]',
  'Secure fixed return with tax benefits', 90, 'active'
),
(
  'po-rd-001', 'Post Office Recurring Deposit', 'recurring-deposit',
  'Monthly savings plan with fixed tenure and guaranteed returns.',
  '["recurring_deposit"]'::jsonb, 6.70, 60, 60, 100, NULL,
  'Resident individuals; account can be opened at post office or digitally where available.',
  '6.70% p.a. on monthly deposits; 5-year standard tenure.',
  'Interest taxable as per slab; TDS applicable above threshold.',
  TRUE, 'recurring_deposit', 'quarterly', 'https://www.indiapost.gov.in/',
  '["Monthly discipline","Fixed tenure","Nomination facility"]',
  'Build savings with small monthly contributions', 80, 'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO government_schemes (
  id, ministry_name, name, slug, description, categories,
  loan_amount_min, loan_amount_max, subsidy_percent, interest_rate,
  eligibility_text, benefits_text, application_url, features, highlights, display_priority, status
) VALUES
(
  'gov-mudra-001', 'Ministry of Finance', 'PM Mudra Yojana', 'pm-mudra',
  'Collateral-free loans for micro and small enterprises under Shishu, Kishore and Tarun categories.',
  '["pm_mudra"]'::jsonb, 50000, 1000000, NULL, NULL,
  'Non-corporate small business units; proprietorship, partnership, or company engaged in income-generating activity.',
  'Loans up to ₹10 lakh without collateral; Shishu (up to ₹50K), Kishore (₹50K–5L), Tarun (₹5L–10L).',
  'https://www.mudra.org.in/',
  '["No collateral up to ₹10L","Working capital & term loans","Through banks/NBFCs/MFIs"]',
  'Flagship MSME credit scheme', 100, 'active'
),
(
  'gov-nps-001', 'PFRDA', 'National Pension System (NPS)', 'nps',
  'Market-linked voluntary retirement savings scheme with tax benefits.',
  '["nps"]'::jsonb, NULL, NULL, NULL, NULL,
  'Indian citizens aged 18–70; open to salaried and self-employed.',
  'Flexible contributions; choice of pension fund managers; partial withdrawal rules; annuity at retirement.',
  'https://www.npscra.nsdl.co.in/',
  '["Tier I & Tier II accounts","Additional ₹50K deduction u/s 80CCD(1B)","Portable across employers"]',
  'Build retirement corpus with market returns', 95, 'active'
),
(
  'gov-ayushman-001', 'Ministry of Health', 'Ayushman Bharat PM-JAY', 'ayushman-bharat',
  'Health insurance cover for eligible families for secondary and tertiary hospitalisation.',
  '["ayushman_bharat"]'::jsonb, NULL, NULL, NULL, NULL,
  'Families identified via SECC database; eligibility varies by state implementation.',
  'Cashless cover up to ₹5 lakh per family per year for listed procedures at empanelled hospitals.',
  'https://pmjay.gov.in/',
  '["₹5L family floater","Cashless treatment","Wide hospital network"]',
  'World''s largest government-funded health assurance', 90, 'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO investment_products (
  id, provider_name, name, slug, description, categories,
  returns_1y, returns_3y, risk_level, expense_ratio, min_investment_amount,
  tax_benefits_text, maturity_tenure_text, apply_url, features, highlights, display_priority, status
) VALUES
(
  'inv-sgb-001', 'RBI / Government of India', 'Sovereign Gold Bond Series', 'sovereign-gold-bonds',
  'Government securities denominated in grams of gold with annual interest and capital gains benefit on maturity.',
  '["sovereign_gold_bonds"]'::jsonb, 11.50, 12.80, 'moderate', NULL, 1,
  'Interest taxable; long-term capital gains on redemption exempt if held to maturity.',
  '8-year tenure with exit from 5th year on interest payment dates.',
  'https://www.rbi.org.in/',
  '["2.50% annual interest","Issued in tranches","Demat or paper form"]',
  'Gold exposure without physical storage', 100, 'active'
),
(
  'inv-gold-etf-001', 'NSE / AMCs', 'Gold ETF (Representative)', 'gold-etf',
  'Exchange-traded fund tracking domestic gold prices with high liquidity.',
  '["gold_etf"]'::jsonb, 18.20, 14.50, 'moderate', 0.50, 100,
  'LTCG rules apply; STCG as per equity/debt classification of the fund.',
  'No fixed maturity; trade on exchange during market hours.',
  'https://www.nseindia.com/',
  '["Real-time pricing","Low expense vs physical gold","Demat holding"]',
  'Liquid gold allocation via exchange', 90, 'active'
),
(
  'inv-reit-001', 'SEBI Registered REIT', 'Listed REIT (Representative)', 'reit',
  'Real Estate Investment Trust offering rental yield and portfolio diversification.',
  '["reit"]'::jsonb, 8.50, 9.20, 'moderately_high', 0.35, 10000,
  'Dividend distribution tax rules apply; consult tax advisor for slab impact.',
  'Perpetual; listed on stock exchanges with periodic distributions.',
  'https://www.sebi.gov.in/',
  '["Rental income distribution","Professional asset management","Listed liquidity"]',
  'Access commercial real estate with smaller ticket size', 85, 'active'
)
ON CONFLICT (id) DO NOTHING;
