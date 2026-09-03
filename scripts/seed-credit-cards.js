/**
 * Seed sample credit cards for marketplace demo.
 * Idempotent: skips cards that already exist by slug.
 * Backfills CredLaxmi reward_rules when a seeded card has none.
 *
 * Usage (from backend/):
 *   npm run seed:credit-cards
 */
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { ensureCreditCardSchema } from '../src/db/ensureCreditCardSchema.js';
import { getPool } from '../src/db/pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

const SAMPLE_CARDS = [
  {
    slug: 'hdfc-millennia',
    bankName: 'HDFC Bank',
    name: 'HDFC Millennia Credit Card',
    categories: ['cashback', 'shopping'],
    annualFee: 1000,
    joiningFee: 0,
    rewardPoints: '5% cashback on Amazon, Flipkart & more',
    loungeAccess: false,
    fuelSurchargeWaiver: true,
    movieBenefits: false,
    diningBenefits: true,
    diningBenefitsDetails: '15% off at partner restaurants',
    insuranceCover: false,
    forexCharges: '3.5%',
    emiConversion: true,
    emiConversionDetails: 'SmartEMI on spends above ₹2,500',
    cardNetwork: 'Visa',
    features: ['5% cashback on partner merchants', '1% cashback on other spends'],
    applyUrl: 'https://www.hdfcbank.com/personal/pay/cards/credit-cards',
    displayPriority: 100,
  },
  {
    slug: 'sbi-simplyclick',
    bankName: 'SBI Card',
    name: 'SBI SimplyCLICK Credit Card',
    categories: ['cashback', 'shopping', 'co_branded'],
    annualFee: 499,
    joiningFee: 499,
    rewardPoints: '10X rewards on online shopping',
    loungeAccess: false,
    fuelSurchargeWaiver: true,
    movieBenefits: true,
    movieBenefitsDetails: '₹500 BookMyShow voucher annually',
    diningBenefits: false,
    insuranceCover: false,
    forexCharges: '3.5%',
    emiConversion: true,
    cardNetwork: 'Visa',
    features: ['10X rewards on Amazon, BookMyShow, etc.', 'Fuel surcharge waiver'],
    applyUrl: 'https://www.sbicard.com/',
    displayPriority: 90,
  },
  {
    slug: 'axis-ace',
    bankName: 'Axis Bank',
    name: 'Axis Bank ACE Credit Card',
    categories: ['cashback', 'upi'],
    annualFee: 0,
    joiningFee: 0,
    rewardPoints: '5% cashback on bill payments via Google Pay',
    loungeAccess: false,
    fuelSurchargeWaiver: false,
    movieBenefits: false,
    diningBenefits: false,
    insuranceCover: false,
    forexCharges: '3.5%',
    emiConversion: true,
    cardNetwork: 'Visa',
    features: ['5% cashback on utility & mobile recharges', 'Lifetime free card'],
    applyUrl: 'https://www.axisbank.com/retail/cards/credit-card',
    displayPriority: 95,
  },
  {
    slug: 'icici-amazon-pay',
    bankName: 'ICICI Bank',
    name: 'Amazon Pay ICICI Credit Card',
    categories: ['cashback', 'shopping', 'co_branded'],
    annualFee: 0,
    joiningFee: 0,
    rewardPoints: '5% on Amazon for Prime members',
    loungeAccess: false,
    fuelSurchargeWaiver: false,
    movieBenefits: false,
    diningBenefits: false,
    insuranceCover: false,
    forexCharges: '3.5%',
    emiConversion: true,
    cardNetwork: 'Visa',
    features: ['Lifetime free', 'Instant Amazon Pay integration'],
    applyUrl: 'https://www.icicibank.com/',
    displayPriority: 88,
  },
  {
    slug: 'hdfc-regalia-gold',
    bankName: 'HDFC Bank',
    name: 'HDFC Regalia Gold Credit Card',
    categories: ['travel', 'premium', 'airport_lounge'],
    annualFee: 2500,
    joiningFee: 2500,
    rewardPoints: '4 reward points per ₹150 spent',
    loungeAccess: true,
    loungeAccessDetails: '12 domestic + 6 international lounge visits per year',
    fuelSurchargeWaiver: true,
    movieBenefits: false,
    diningBenefits: true,
    diningBenefitsDetails: 'Dineout program benefits',
    insuranceCover: true,
    insuranceCoverDetails: 'Air accident cover up to ₹1 crore',
    forexCharges: '2%',
    emiConversion: true,
    cardNetwork: 'Visa',
    features: ['Premium travel benefits', 'Complimentary lounge access'],
    applyUrl: 'https://www.hdfcbank.com/personal/pay/cards/credit-cards',
    displayPriority: 85,
  },
  {
    slug: 'axis-magnus',
    bankName: 'Axis Bank',
    name: 'Axis Bank Magnus Credit Card',
    categories: ['travel', 'premium', 'airport_lounge'],
    annualFee: 12500,
    joiningFee: 10000,
    rewardPoints: '12 EDGE reward points per ₹200',
    loungeAccess: true,
    loungeAccessDetails: 'Unlimited domestic + international lounge access',
    fuelSurchargeWaiver: true,
    movieBenefits: false,
    diningBenefits: true,
    diningBenefitsDetails: 'BOGO offers at partner restaurants',
    insuranceCover: true,
    insuranceCoverDetails: 'Travel & medical insurance included',
    forexCharges: '2%',
    emiConversion: true,
    cardNetwork: 'Visa',
    features: ['Premium metal card', 'Best-in-class travel rewards'],
    applyUrl: 'https://www.axisbank.com/retail/cards/credit-card',
    displayPriority: 80,
  },
  {
    slug: 'iob-rupay',
    bankName: 'Indian Overseas Bank',
    name: 'IOB RuPay Platinum Credit Card',
    categories: ['rupay', 'upi', 'fuel'],
    annualFee: 0,
    joiningFee: 0,
    rewardPoints: '1 reward point per ₹100 spent',
    loungeAccess: false,
    fuelSurchargeWaiver: true,
    movieBenefits: false,
    diningBenefits: false,
    insuranceCover: false,
    forexCharges: 'Zero markup on UPI spends',
    emiConversion: false,
    cardNetwork: 'RuPay',
    features: ['RuPay credit on UPI', 'Fuel surcharge waiver at HPCL'],
    applyUrl: 'https://www.iob.in/',
    displayPriority: 70,
  },
  {
    slug: 'sbi-bpcl',
    bankName: 'SBI Card',
    name: 'BPCL SBI Credit Card',
    categories: ['fuel', 'co_branded'],
    annualFee: 499,
    joiningFee: 499,
    rewardPoints: '4.25% value back on fuel at BPCL',
    loungeAccess: false,
    fuelSurchargeWaiver: true,
    movieBenefits: false,
    diningBenefits: false,
    insuranceCover: false,
    forexCharges: '3.5%',
    emiConversion: true,
    cardNetwork: 'Visa',
    features: ['Best for BPCL fuel stations', 'Fuel surcharge waiver'],
    applyUrl: 'https://www.sbicard.com/',
    displayPriority: 75,
  },
  {
    slug: 'idfc-first-wow',
    bankName: 'IDFC FIRST Bank',
    name: 'IDFC FIRST WOW Credit Card',
    categories: ['student', 'secured'],
    annualFee: 0,
    joiningFee: 0,
    rewardPoints: 'Rewards on everyday spends',
    loungeAccess: false,
    fuelSurchargeWaiver: false,
    movieBenefits: false,
    diningBenefits: false,
    insuranceCover: false,
    forexCharges: '1.99%',
    emiConversion: true,
    cardNetwork: 'Visa',
    features: ['Ideal for students & first-time users', 'FD-backed secured option available'],
    applyUrl: 'https://www.idfcfirstbank.com/',
    displayPriority: 65,
  },
  {
    slug: 'amex-platinum-travel',
    bankName: 'American Express',
    name: 'Platinum Travel Credit Card',
    categories: ['travel', 'premium', 'airport_lounge'],
    annualFee: 5000,
    joiningFee: 3500,
    rewardPoints: 'Membership Rewards on every spend',
    loungeAccess: true,
    loungeAccessDetails: 'Priority Pass membership included',
    fuelSurchargeWaiver: false,
    movieBenefits: true,
    movieBenefitsDetails: 'Buy One Get One on BookMyShow',
    diningBenefits: true,
    diningBenefitsDetails: 'Dining offers at premium restaurants',
    insuranceCover: true,
    insuranceCoverDetails: 'Travel inconvenience insurance',
    forexCharges: '0%',
    emiConversion: true,
    cardNetwork: 'American Express',
    features: ['Zero forex markup', 'Premium travel card'],
    applyUrl: 'https://www.americanexpress.com/in/',
    displayPriority: 78,
  },
  {
    slug: 'kotak-business',
    bankName: 'Kotak Mahindra Bank',
    name: 'Kotak Business Credit Card',
    categories: ['business'],
    annualFee: 1500,
    joiningFee: 0,
    rewardPoints: '2 reward points per ₹100 on business spends',
    loungeAccess: true,
    loungeAccessDetails: '2 domestic lounge visits per quarter',
    fuelSurchargeWaiver: true,
    movieBenefits: false,
    diningBenefits: false,
    insuranceCover: true,
    insuranceCoverDetails: 'Purchase protection on business expenses',
    forexCharges: '3.5%',
    emiConversion: true,
    cardNetwork: 'Visa',
    features: ['Designed for business expenses', 'Higher credit limits'],
    applyUrl: 'https://www.kotak.com/',
    displayPriority: 60,
  },
];

function earn(categoryCode, pointsEarned, extra = {}) {
  return {
    category_code: categoryCode,
    points_earned: pointsEarned,
    spend_unit_inr: 100,
    ...extra,
  };
}

function cashbackRules({
  rates,
  annualFeeWaiverSpendThreshold = null,
  welcomeBenefitInr = 0,
  milestoneThreshold = 0,
  milestoneBonus = 0,
  loungeVisitsPerYear = 0,
  loungeVisitValueInr = 0,
  redemptionValueInr = 1,
}) {
  return {
    fees: {
      annual_fee_waiver_spend_threshold: annualFeeWaiverSpendThreshold,
    },
    reward_currency: {
      type: redemptionValueInr === 1 ? 'cashback' : 'points',
      redemption_value_inr: redemptionValueInr,
    },
    earn_rates: rates,
    welcome_benefits: welcomeBenefitInr > 0 ? [{ value_inr: welcomeBenefitInr }] : [],
    milestone_benefits:
      milestoneThreshold > 0 && milestoneBonus > 0
        ? [{ spend_threshold: milestoneThreshold, bonus_inr: milestoneBonus, frequency: 'annual' }]
        : [],
    additional_benefits: {
      lounge_visits_per_year: loungeVisitsPerYear,
      lounge_visit_value_inr: loungeVisitValueInr,
    },
  };
}

/** Distinct CredLaxmi rules so compare ranking is spend-driven, not 1% default. */
const REWARD_RULES_BY_SLUG = {
  'hdfc-millennia': cashbackRules({
    rates: [
      earn('ONLINE_SHOPPING', 5),
      earn('DINING_FOOD', 2.5),
      earn('GROCERIES', 1),
      earn('MISC_BASE', 1),
    ],
    annualFeeWaiverSpendThreshold: 100000,
  }),
  'sbi-simplyclick': cashbackRules({
    rates: [
      earn('ONLINE_SHOPPING', 5),
      earn('DINING_FOOD', 2),
      earn('MISC_BASE', 1),
    ],
    annualFeeWaiverSpendThreshold: 100000,
  }),
  'axis-ace': cashbackRules({
    rates: [
      earn('UTILITIES_BILLS', 5),
      earn('GROCERIES', 2),
      earn('MISC_BASE', 1.5),
    ],
  }),
  'icici-amazon-pay': cashbackRules({
    rates: [
      earn('ONLINE_SHOPPING', 5),
      earn('UTILITIES_BILLS', 2),
      earn('MISC_BASE', 1),
    ],
  }),
  'hdfc-regalia-gold': cashbackRules({
    redemptionValueInr: 0.25,
    rates: [
      earn('TRAVEL_FLIGHTS', 8),
      earn('DINING_FOOD', 4),
      earn('MISC_BASE', 2),
    ],
    annualFeeWaiverSpendThreshold: 300000,
    welcomeBenefitInr: 2500,
    milestoneThreshold: 400000,
    milestoneBonus: 1500,
    loungeVisitsPerYear: 12,
    loungeVisitValueInr: 1500,
  }),
  'axis-magnus': cashbackRules({
    redemptionValueInr: 0.25,
    rates: [
      earn('TRAVEL_FLIGHTS', 12),
      earn('TRAVEL_LODGING', 8),
      earn('MISC_BASE', 2),
    ],
    annualFeeWaiverSpendThreshold: 1500000,
    welcomeBenefitInr: 10000,
    loungeVisitsPerYear: 8,
    loungeVisitValueInr: 2000,
  }),
  'iob-rupay': cashbackRules({
    rates: [earn('FUEL', 1), earn('MISC_BASE', 1)],
  }),
  'sbi-bpcl': cashbackRules({
    rates: [earn('FUEL', 4.25), earn('MISC_BASE', 1)],
    annualFeeWaiverSpendThreshold: 50000,
  }),
  'idfc-first-wow': cashbackRules({
    rates: [earn('MISC_BASE', 1), earn('ONLINE_SHOPPING', 1)],
  }),
  'amex-platinum-travel': cashbackRules({
    redemptionValueInr: 0.4,
    rates: [
      earn('TRAVEL_FLIGHTS', 5),
      earn('DINING_FOOD', 3),
      earn('MISC_BASE', 1),
    ],
    annualFeeWaiverSpendThreshold: 400000,
    loungeVisitsPerYear: 4,
    loungeVisitValueInr: 1500,
  }),
  'kotak-business': cashbackRules({
    rates: [
      earn('VENDOR_PAYMENTS', 3),
      earn('OFFICE_SUPPLIES', 2),
      earn('ADVERTISING_SOFTWARE', 2),
      earn('CLIENT_ENTERTAINMENT', 2),
      earn('TRAVEL_LODGING', 2),
      earn('MISC_BASE', 1),
    ],
    annualFeeWaiverSpendThreshold: 200000,
    loungeVisitsPerYear: 8,
    loungeVisitValueInr: 1500,
  }),
};

function hasEarnRates(raw) {
  if (!raw) return false;
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const rates = obj?.earn_rates || obj?.earnRates || [];
    return Array.isArray(rates) && rates.length > 0;
  } catch {
    return false;
  }
}

async function seed() {
  await ensureCreditCardSchema();
  const pool = getPool();
  let inserted = 0;
  let backfilled = 0;

  for (const card of SAMPLE_CARDS) {
    const rules = REWARD_RULES_BY_SLUG[card.slug] || null;
    const waiver = rules?.fees?.annual_fee_waiver_spend_threshold ?? null;
    const [[existing]] = await pool.execute(
      `SELECT id, reward_rules FROM credit_cards WHERE slug = :slug LIMIT 1`,
      { slug: card.slug },
    );

    if (existing) {
      if (rules && !hasEarnRates(existing.reward_rules)) {
        await pool.execute(
          `UPDATE credit_cards
           SET reward_rules = :rewardRules::jsonb,
               annual_fee_waiver_spend_threshold = :waiver
           WHERE id = :id`,
          {
            id: existing.id,
            rewardRules: JSON.stringify(rules),
            waiver,
          },
        );
        backfilled += 1;
        console.log(`  ↻ Backfilled CredLaxmi rules: ${card.name}`);
      } else {
        console.log(`  ↷ Skipped (exists): ${card.name}`);
      }
      continue;
    }

    const id = randomUUID();
    await pool.execute(
      `INSERT INTO credit_cards (
        id, bank_id, bank_name, name, slug, description, logo_url, card_network,
        categories, annual_fee, joining_fee, interest_rate, late_payment_fee, other_charges,
        features, advantages, benefits,
        reward_points, annual_fee_waiver_spend_threshold, reward_rules,
        lounge_access, lounge_access_details,
        fuel_surcharge_waiver, movie_benefits, movie_benefits_details,
        dining_benefits, dining_benefits_details, insurance_cover, insurance_cover_details,
        forex_charges, emi_conversion, emi_conversion_details,
        apply_url, display_priority, status
      ) VALUES (
        :id, NULL, :bankName, :name, :slug, NULL, NULL, :cardNetwork,
        :categories::jsonb, :annualFee, :joiningFee, NULL, NULL, NULL,
        :features, '[]', '[]',
        :rewardPoints, :waiver, :rewardRules::jsonb,
        :loungeAccess, :loungeAccessDetails,
        :fuelSurchargeWaiver, :movieBenefits, :movieBenefitsDetails,
        :diningBenefits, :diningBenefitsDetails, :insuranceCover, :insuranceCoverDetails,
        :forexCharges, :emiConversion, :emiConversionDetails,
        :applyUrl, :displayPriority, 'active'
      )`,
      {
        id,
        bankName: card.bankName,
        name: card.name,
        slug: card.slug,
        cardNetwork: card.cardNetwork,
        categories: JSON.stringify(card.categories),
        annualFee: card.annualFee,
        joiningFee: card.joiningFee,
        features: JSON.stringify(card.features),
        rewardPoints: card.rewardPoints,
        waiver,
        rewardRules: rules ? JSON.stringify(rules) : null,
        loungeAccess: card.loungeAccess,
        loungeAccessDetails: card.loungeAccessDetails || null,
        fuelSurchargeWaiver: card.fuelSurchargeWaiver,
        movieBenefits: card.movieBenefits,
        movieBenefitsDetails: card.movieBenefitsDetails || null,
        diningBenefits: card.diningBenefits,
        diningBenefitsDetails: card.diningBenefitsDetails || null,
        insuranceCover: card.insuranceCover,
        insuranceCoverDetails: card.insuranceCoverDetails || null,
        forexCharges: card.forexCharges,
        emiConversion: card.emiConversion,
        emiConversionDetails: card.emiConversionDetails || null,
        applyUrl: card.applyUrl,
        displayPriority: card.displayPriority,
      },
    );
    inserted += 1;
    console.log(`  ✓ Created: ${card.name}`);
  }

  console.log(
    `\nDone seeding credit cards. Created ${inserted}; backfilled CredLaxmi rules on ${backfilled}.`,
  );
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
