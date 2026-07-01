/**
 * Seed sample mutual funds for marketplace demo.
 */
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { getPool } from '../src/db/pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

const PLACEHOLDER_URL = 'https://www.amfiindia.com';

const SAMPLE_FUNDS = [
  { slug: 'hdfc-flexi-cap', amcName: 'HDFC Mutual Fund', name: 'HDFC Flexi Cap Fund', categories: ['flexi_cap', 'sip', 'lumpsum'], returns1y: 22.4, returns3y: 18.6, returns5y: 16.2, riskLevel: 'very_high', expenseRatio: 1.05, fundManager: 'Roshi Jain', aumCrores: 65000, rating: 5, minSipAmount: 500, supportsSip: true, supportsLumpsum: true, displayPriority: 100, features: ['Flexible allocation across market caps'] },
  { slug: 'sbi-bluechip', amcName: 'SBI Mutual Fund', name: 'SBI Bluechip Fund', categories: ['large_cap', 'sip', 'lumpsum'], returns1y: 18.2, returns3y: 15.4, returns5y: 14.1, riskLevel: 'moderately_high', expenseRatio: 0.95, fundManager: 'Sohini Andani', aumCrores: 42000, rating: 4.5, minSipAmount: 500, displayPriority: 98 },
  { slug: 'axis-midcap', amcName: 'Axis Mutual Fund', name: 'Axis Midcap Fund', categories: ['mid_cap', 'sip', 'lumpsum'], returns1y: 25.1, returns3y: 20.3, returns5y: 18.5, riskLevel: 'very_high', expenseRatio: 1.45, fundManager: 'Shreyash Devalkar', aumCrores: 28000, rating: 4.5, minSipAmount: 500, displayPriority: 95 },
  { slug: 'nippon-small-cap', amcName: 'Nippon India MF', name: 'Nippon India Small Cap Fund', categories: ['small_cap', 'sip', 'lumpsum'], returns1y: 32.5, returns3y: 24.8, returns5y: 22.1, riskLevel: 'very_high', expenseRatio: 1.65, fundManager: 'Samir Rachh', aumCrores: 35000, rating: 4, minSipAmount: 500, displayPriority: 92 },
  { slug: 'mirae-elss', amcName: 'Mirae Asset MF', name: 'Mirae Asset ELSS Tax Saver', categories: ['elss', 'sip', 'lumpsum'], returns1y: 20.8, returns3y: 17.2, returns5y: 15.8, riskLevel: 'very_high', expenseRatio: 0.55, fundManager: 'Neelesh Surana', aumCrores: 22000, rating: 5, minSipAmount: 500, displayPriority: 90, features: ['Section 80C tax benefit', '3-year lock-in'] },
  { slug: 'parag-parikh-flexi', amcName: 'PPFAS Mutual Fund', name: 'Parag Parikh Flexi Cap Fund', categories: ['flexi_cap', 'sip', 'lumpsum'], returns1y: 19.5, returns3y: 16.8, returns5y: 15.2, riskLevel: 'moderately_high', expenseRatio: 0.62, fundManager: 'Rajeev Thakkar', aumCrores: 78000, rating: 5, minSipAmount: 1000, displayPriority: 99 },
  { slug: 'icici-liquid', amcName: 'ICICI Prudential MF', name: 'ICICI Prudential Liquid Fund', categories: ['liquid_funds', 'lumpsum'], returns1y: 7.2, returns3y: 6.5, returns5y: 6.1, riskLevel: 'low', expenseRatio: 0.2, fundManager: 'Anagha Kanadkar', aumCrores: 55000, rating: 4.5, minSipAmount: 500, displayPriority: 88 },
  { slug: 'hdfc-short-term-debt', amcName: 'HDFC Mutual Fund', name: 'HDFC Short Term Debt Fund', categories: ['debt_funds', 'sip', 'lumpsum'], returns1y: 8.1, returns3y: 7.2, returns5y: 6.8, riskLevel: 'low_to_moderate', expenseRatio: 0.35, fundManager: 'Anupam Joshi', aumCrores: 18000, rating: 4, minSipAmount: 500, displayPriority: 85 },
  { slug: 'icici-balanced', amcName: 'ICICI Prudential MF', name: 'ICICI Prudential Balanced Advantage', categories: ['hybrid_funds', 'sip', 'lumpsum'], returns1y: 14.5, returns3y: 12.8, returns5y: 11.5, riskLevel: 'moderate', expenseRatio: 0.85, fundManager: 'Manish Banthia', aumCrores: 62000, rating: 4.5, minSipAmount: 500, displayPriority: 87 },
  { slug: 'uti-nifty-index', amcName: 'UTI Mutual Fund', name: 'UTI Nifty 50 Index Fund', categories: ['index_funds', 'sip', 'lumpsum', 'etf'], returns1y: 16.8, returns3y: 14.2, returns5y: 13.5, riskLevel: 'high', expenseRatio: 0.18, fundManager: 'Amit Patra', aumCrores: 12000, rating: 4, minSipAmount: 500, displayPriority: 82 },
  { slug: 'motilal-nasdaq', amcName: 'Motilal Oswal MF', name: 'Motilal Oswal Nasdaq 100 Fund of Fund', categories: ['international_funds', 'sip', 'lumpsum'], returns1y: 28.4, returns3y: 19.5, returns5y: 17.2, riskLevel: 'very_high', expenseRatio: 0.45, fundManager: 'Ravi Gopalakrishnan', aumCrores: 8500, rating: 4, minSipAmount: 500, displayPriority: 80, features: ['US tech exposure via Nasdaq 100'] },
  { slug: 'navi-nifty-etf', amcName: 'Navi Mutual Fund', name: 'Navi Nifty 50 ETF', categories: ['etf', 'index_funds', 'lumpsum'], returns1y: 16.5, returns3y: 14.0, returns5y: 13.2, riskLevel: 'high', expenseRatio: 0.06, fundManager: 'Fund Management Team', aumCrores: 2500, rating: 4, minLumpsumAmount: 100, supportsSip: false, displayPriority: 75 },
  { slug: 'kotak-emerging-equity', amcName: 'Kotak Mutual Fund', name: 'Kotak Emerging Equity Fund', categories: ['mid_cap', 'sip', 'lumpsum'], returns1y: 24.2, returns3y: 19.8, returns5y: 17.5, riskLevel: 'very_high', expenseRatio: 1.55, fundManager: 'Pankaj Tibrewal', aumCrores: 32000, rating: 4.5, minSipAmount: 500, displayPriority: 86 },
  { slug: 'axis-elss', amcName: 'Axis Mutual Fund', name: 'Axis Long Term Equity Fund (ELSS)', categories: ['elss', 'sip'], returns1y: 19.2, returns3y: 16.5, returns5y: 14.8, riskLevel: 'very_high', expenseRatio: 0.68, fundManager: 'Jinesh Gopani', aumCrores: 30000, rating: 4.5, minSipAmount: 500, displayPriority: 84 },
];

async function seed() {
  const pool = getPool();
  for (const fund of SAMPLE_FUNDS) {
    const [[existing]] = await pool.execute(`SELECT id FROM mutual_funds WHERE slug = :slug LIMIT 1`, { slug: fund.slug });
    if (existing) { console.log(`  ↷ Skipped: ${fund.name}`); continue; }
    const id = randomUUID();
    await pool.execute(
      `INSERT INTO mutual_funds (
        id, amc_id, amc_name, name, slug, categories,
        returns_1y, returns_3y, returns_5y, risk_level, expense_ratio, fund_manager,
        aum_crores, rating, min_sip_amount, min_lumpsum_amount,
        supports_sip, supports_lumpsum, invest_url, features, display_priority, status
      ) VALUES (
        :id, NULL, :amcName, :name, :slug, :categories::jsonb,
        :returns1y, :returns3y, :returns5y, :riskLevel, :expenseRatio, :fundManager,
        :aumCrores, :rating, :minSipAmount, :minLumpsumAmount,
        :supportsSip, :supportsLumpsum, :investUrl, :features, :displayPriority, 'active'
      )`,
      {
        id,
        amcName: fund.amcName,
        name: fund.name,
        slug: fund.slug,
        categories: JSON.stringify(fund.categories),
        returns1y: fund.returns1y ?? null,
        returns3y: fund.returns3y ?? null,
        returns5y: fund.returns5y ?? null,
        riskLevel: fund.riskLevel ?? null,
        expenseRatio: fund.expenseRatio ?? null,
        fundManager: fund.fundManager ?? null,
        aumCrores: fund.aumCrores ?? null,
        rating: fund.rating ?? null,
        minSipAmount: fund.minSipAmount ?? 500,
        minLumpsumAmount: fund.minLumpsumAmount ?? 5000,
        supportsSip: fund.supportsSip !== false,
        supportsLumpsum: fund.supportsLumpsum !== false,
        investUrl: PLACEHOLDER_URL,
        features: JSON.stringify(fund.features || []),
        displayPriority: fund.displayPriority ?? 0,
      },
    );
    console.log(`  ✓ Created: ${fund.name}`);
  }
  console.log('\nDone seeding mutual funds.');
  process.exit(0);
}

seed().catch((err) => { console.error(err); process.exit(1); });
