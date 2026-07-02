import { getPool } from '../db/pool.js';

const SETTINGS_ID = 'default';

const DEFAULT_VISIBILITY = {
  bankMarketplace: true,
  creditCardMarketplace: true,
  insuranceMarketplace: true,
  mutualFundMarketplace: true,
  fixedIncomeMarketplace: true,
  postOfficeMarketplace: true,
  governmentSchemesMarketplace: true,
  investmentMarketplace: true,
};

function mapRow(row) {
  if (!row) return { ...DEFAULT_VISIBILITY };
  return {
    bankMarketplace: Boolean(row.bank_marketplace_enabled),
    creditCardMarketplace: Boolean(row.credit_card_marketplace_enabled),
    insuranceMarketplace: Boolean(row.insurance_marketplace_enabled),
    mutualFundMarketplace: Boolean(row.mutual_fund_marketplace_enabled),
    fixedIncomeMarketplace: Boolean(row.fixed_income_marketplace_enabled),
    postOfficeMarketplace: Boolean(row.post_office_marketplace_enabled),
    governmentSchemesMarketplace: Boolean(row.government_schemes_marketplace_enabled),
    investmentMarketplace: Boolean(row.investment_marketplace_enabled),
    updatedAt: row.updated_at || null,
  };
}

export async function getMarketplaceVisibility() {
  const pool = getPool();
  const [[row]] = await pool.execute(
    'SELECT * FROM marketplace_visibility_settings WHERE id = :id LIMIT 1',
    { id: SETTINGS_ID },
  );
  return mapRow(row);
}

export async function updateMarketplaceVisibility(input, updatedBy) {
  const pool = getPool();
  await pool.execute(
    `INSERT INTO marketplace_visibility_settings (
       id, bank_marketplace_enabled, credit_card_marketplace_enabled,
       insurance_marketplace_enabled, mutual_fund_marketplace_enabled,
       fixed_income_marketplace_enabled, post_office_marketplace_enabled,
       government_schemes_marketplace_enabled, investment_marketplace_enabled,
       updated_by
     ) VALUES (
       :id, :bank_enabled, :cc_enabled, :insurance_enabled, :mf_enabled, :fi_enabled,
       :po_enabled, :gov_enabled, :inv_enabled, :updated_by
     )
     ON CONFLICT (id) DO UPDATE SET
       bank_marketplace_enabled = EXCLUDED.bank_marketplace_enabled,
       credit_card_marketplace_enabled = EXCLUDED.credit_card_marketplace_enabled,
       insurance_marketplace_enabled = EXCLUDED.insurance_marketplace_enabled,
       mutual_fund_marketplace_enabled = EXCLUDED.mutual_fund_marketplace_enabled,
       fixed_income_marketplace_enabled = EXCLUDED.fixed_income_marketplace_enabled,
       post_office_marketplace_enabled = EXCLUDED.post_office_marketplace_enabled,
       government_schemes_marketplace_enabled = EXCLUDED.government_schemes_marketplace_enabled,
       investment_marketplace_enabled = EXCLUDED.investment_marketplace_enabled,
       updated_by = EXCLUDED.updated_by,
       updated_at = CURRENT_TIMESTAMP`,
    {
      id: SETTINGS_ID,
      bank_enabled: input.bankMarketplace ? 1 : 0,
      cc_enabled: input.creditCardMarketplace ? 1 : 0,
      insurance_enabled: input.insuranceMarketplace ? 1 : 0,
      mf_enabled: input.mutualFundMarketplace ? 1 : 0,
      fi_enabled: input.fixedIncomeMarketplace ? 1 : 0,
      po_enabled: input.postOfficeMarketplace ? 1 : 0,
      gov_enabled: input.governmentSchemesMarketplace ? 1 : 0,
      inv_enabled: input.investmentMarketplace ? 1 : 0,
      updated_by: updatedBy ?? null,
    },
  );
  return getMarketplaceVisibility();
}
