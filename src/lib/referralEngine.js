import { createHash, randomUUID } from 'node:crypto';

import { getPool, isDuplicateColumnError, isIgnorableMigrationError } from '../db/pool.js';
import { newId } from './ids.js';
import {
  ensureReferralSchema,
  normalizeReferralCode,
  normalizeReferralProgram,
  resolveReferralCode,
} from './referralTracking.js';
import { resolveAgentCommissionConfig } from './agentCommission.js';
import { calculateCommissionFromAmount } from './agentCustomerProvision.js';

const LIFECYCLE_ORDER = [
  'clicked',
  'registered',
  'lead',
  'application',
  'submitted',
  'approved',
  'disbursed',
  'reward_eligible',
  'reward_pending',
  'reward_paid',
  'expired',
  'fraud_suspected',
  'rejected',
];

const PAYMENT_STATUSES = new Set([
  'pending_verification',
  'verified',
  'approved',
  'payable',
  'paid',
  'rejected',
  'ineligible',
]);

const WINDOW_OPTIONS = new Set([30, 60, 90, 180, 0]); // 0 = lifetime

let engineSchemaReady = false;

function hashIp(ip) {
  if (!ip) return null;
  return createHash('sha256').update(String(ip)).digest('hex').slice(0, 64);
}

function addDays(date, days) {
  if (!days || days <= 0) return null;
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function lifecycleRank(status) {
  const idx = LIFECYCLE_ORDER.indexOf(String(status || '').toLowerCase());
  return idx >= 0 ? idx : -1;
}

function canAdvance(from, to) {
  const a = lifecycleRank(from);
  const b = lifecycleRank(to);
  if (b < 0) return false;
  if (['expired', 'fraud_suspected', 'rejected'].includes(String(from || '').toLowerCase())) {
    return false;
  }
  return b >= a;
}

function parseJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

async function nextPublicId(pool, prefix) {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
  return `${prefix}-${suffix}`;
}

export async function ensureReferralEngineSchema(pool = getPool()) {
  if (engineSchemaReady) return;
  await ensureReferralSchema(pool);
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS referral_settings (
        id VARCHAR(32) NOT NULL DEFAULT 'default',
        attribution_window_days INTEGER NOT NULL DEFAULT 90,
        first_touch_policy VARCHAR(32) NOT NULL DEFAULT 'first_valid_wins',
        existing_customer_policy VARCHAR(32) NOT NULL DEFAULT 'retain_original',
        customer_reward_type VARCHAR(16) NOT NULL DEFAULT 'fixed',
        customer_reward_amount NUMERIC(14, 2) NOT NULL DEFAULT 1000,
        customer_reward_min_disbursement NUMERIC(14, 2) NOT NULL DEFAULT 200000,
        customer_reward_trigger VARCHAR(32) NOT NULL DEFAULT 'disbursement',
        customer_reward_max_per_month INTEGER NOT NULL DEFAULT 10,
        agent_commission_tds_rate NUMERIC(8, 4) NOT NULL DEFAULT 0.10,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
    `);
    await pool.execute(`INSERT INTO referral_settings (id) VALUES ('default') ON CONFLICT (id) DO NOTHING`);

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS referral_clicks (
        id CHAR(36) NOT NULL PRIMARY KEY,
        referral_code VARCHAR(64) NOT NULL,
        program VARCHAR(16) NOT NULL,
        referrer_user_id CHAR(36) NULL,
        landing_url TEXT NULL,
        source_url TEXT NULL,
        utm_source VARCHAR(128) NULL,
        utm_medium VARCHAR(128) NULL,
        utm_campaign VARCHAR(128) NULL,
        ip_hash VARCHAR(128) NULL,
        device_ref VARCHAR(255) NULL,
        session_token VARCHAR(64) NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS referral_attributions (
        id CHAR(36) NOT NULL PRIMARY KEY,
        public_id VARCHAR(32) NOT NULL,
        referral_type VARCHAR(16) NOT NULL,
        referrer_user_id CHAR(36) NOT NULL,
        referrer_code VARCHAR(64) NOT NULL,
        referred_user_id CHAR(36) NULL,
        lead_id CHAR(36) NULL,
        click_id CHAR(36) NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'clicked',
        fraud_flag VARCHAR(64) NULL,
        fraud_notes TEXT NULL,
        landing_page VARCHAR(255) NULL,
        source_url TEXT NULL,
        utm_source VARCHAR(128) NULL,
        utm_medium VARCHAR(128) NULL,
        expires_at TIMESTAMPTZ NULL,
        registered_at TIMESTAMPTZ NULL,
        lead_created_at TIMESTAMPTZ NULL,
        application_started_at TIMESTAMPTZ NULL,
        submitted_at TIMESTAMPTZ NULL,
        approved_at TIMESTAMPTZ NULL,
        disbursed_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_referral_attributions_public_id UNIQUE (public_id)
      )
    `);

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS referral_transactions (
        id CHAR(36) NOT NULL PRIMARY KEY,
        public_id VARCHAR(32) NOT NULL,
        attribution_id CHAR(36) NOT NULL,
        referral_type VARCHAR(16) NOT NULL,
        referrer_user_id CHAR(36) NOT NULL,
        referred_user_id CHAR(36) NULL,
        application_id CHAR(36) NULL,
        product VARCHAR(128) NULL,
        lender VARCHAR(255) NULL,
        disbursed_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
        commission_rate NUMERIC(8, 4) NULL,
        commission_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
        reward_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
        tds_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
        net_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
        eligibility_status VARCHAR(32) NOT NULL DEFAULT 'pending',
        payment_status VARCHAR(32) NOT NULL DEFAULT 'pending_verification',
        paid_at TIMESTAMPTZ NULL,
        notes TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_referral_transactions_public_id UNIQUE (public_id)
      )
    `);

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS referral_commission_rules (
        id CHAR(36) NOT NULL PRIMARY KEY,
        product VARCHAR(128) NULL,
        lender VARCHAR(255) NULL,
        agent_type VARCHAR(64) NULL,
        commission_type VARCHAR(16) NOT NULL DEFAULT 'percentage',
        commission_value NUMERIC(14, 4) NOT NULL DEFAULT 1.0,
        min_disbursement NUMERIC(14, 2) NOT NULL DEFAULT 100000,
        max_commission NUMERIC(14, 2) NULL,
        trigger_event VARCHAR(32) NOT NULL DEFAULT 'disbursement',
        tds_rate NUMERIC(8, 4) NOT NULL DEFAULT 0.10,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS referral_reward_rules (
        id CHAR(36) NOT NULL PRIMARY KEY,
        referral_type VARCHAR(16) NOT NULL DEFAULT 'customer',
        qualifying_event VARCHAR(32) NOT NULL DEFAULT 'disbursement',
        reward_type VARCHAR(16) NOT NULL DEFAULT 'fixed',
        reward_value NUMERIC(14, 2) NOT NULL DEFAULT 1000,
        min_disbursement NUMERIC(14, 2) NOT NULL DEFAULT 200000,
        max_rewards_per_month INTEGER NOT NULL DEFAULT 10,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const stampCols = [
      ['user_profiles', 'referral_id', 'CHAR(36) NULL'],
      ['user_profiles', 'referral_type', 'VARCHAR(16) NULL'],
      ['user_profiles', 'referrer_id', 'VARCHAR(64) NULL'],
      ['user_profiles', 'referred_at', 'TIMESTAMPTZ NULL'],
      ['loan_applications', 'referral_id', 'CHAR(36) NULL'],
      ['loan_applications', 'referral_type', 'VARCHAR(16) NULL'],
      ['loan_applications', 'referrer_id', 'VARCHAR(64) NULL'],
    ];
    for (const [table, col, def] of stampCols) {
      try {
        await pool.execute(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${def}`);
      } catch (err) {
        if (!isDuplicateColumnError(err) && !isIgnorableMigrationError(err)) throw err;
      }
    }

    await pool.execute(
      `INSERT INTO referral_commission_rules (
         id, product, commission_type, commission_value, min_disbursement, trigger_event, tds_rate, is_active
       ) VALUES (
         '00000000-0000-4000-8000-000000000001', NULL, 'percentage', 1.0, 100000, 'disbursement', 0.10, TRUE
       ) ON CONFLICT (id) DO NOTHING`,
    ).catch(() => {});
    await pool.execute(
      `INSERT INTO referral_reward_rules (
         id, referral_type, qualifying_event, reward_type, reward_value, min_disbursement, max_rewards_per_month, is_active
       ) VALUES (
         '00000000-0000-4000-8000-000000000002', 'customer', 'disbursement', 'fixed', 1000, 200000, 10, TRUE
       ) ON CONFLICT (id) DO NOTHING`,
    ).catch(() => {});

    engineSchemaReady = true;
  } catch (err) {
    if (isIgnorableMigrationError(err)) {
      engineSchemaReady = true;
      return;
    }
    throw err;
  }
}

export async function getReferralSettings(pool = getPool()) {
  await ensureReferralEngineSchema(pool);
  const [[row]] = await pool.execute(`SELECT * FROM referral_settings WHERE id = 'default' LIMIT 1`);
  return {
    attributionWindowDays: Number(row?.attribution_window_days ?? 90),
    firstTouchPolicy: row?.first_touch_policy || 'first_valid_wins',
    existingCustomerPolicy: row?.existing_customer_policy || 'retain_original',
    customerRewardType: row?.customer_reward_type || 'fixed',
    customerRewardAmount: Number(row?.customer_reward_amount ?? 1000),
    customerRewardMinDisbursement: Number(row?.customer_reward_min_disbursement ?? 200000),
    customerRewardTrigger: row?.customer_reward_trigger || 'disbursement',
    customerRewardMaxPerMonth: Number(row?.customer_reward_max_per_month ?? 10),
    agentCommissionTdsRate: Number(row?.agent_commission_tds_rate ?? 0.1),
  };
}

export async function updateReferralSettings(pool, patch = {}) {
  await ensureReferralEngineSchema(pool);
  const current = await getReferralSettings(pool);
  const windowDays = patch.attributionWindowDays != null
    ? Number(patch.attributionWindowDays)
    : current.attributionWindowDays;
  if (!WINDOW_OPTIONS.has(windowDays) && windowDays !== 0) {
    const err = new Error('attribution_window_days must be 30, 60, 90, 180, or 0 (lifetime)');
    err.status = 400;
    throw err;
  }
  await pool.execute(
    `UPDATE referral_settings SET
       attribution_window_days = :window_days,
       first_touch_policy = :first_touch,
       existing_customer_policy = :existing_policy,
       customer_reward_type = :reward_type,
       customer_reward_amount = :reward_amount,
       customer_reward_min_disbursement = :min_disb,
       customer_reward_trigger = :reward_trigger,
       customer_reward_max_per_month = :max_month,
       agent_commission_tds_rate = :tds_rate,
       updated_at = NOW()
     WHERE id = 'default'`,
    {
      window_days: windowDays,
      first_touch: patch.firstTouchPolicy || current.firstTouchPolicy,
      existing_policy: patch.existingCustomerPolicy || current.existingCustomerPolicy,
      reward_type: patch.customerRewardType || current.customerRewardType,
      reward_amount: patch.customerRewardAmount != null
        ? Number(patch.customerRewardAmount)
        : current.customerRewardAmount,
      min_disb: patch.customerRewardMinDisbursement != null
        ? Number(patch.customerRewardMinDisbursement)
        : current.customerRewardMinDisbursement,
      reward_trigger: patch.customerRewardTrigger || current.customerRewardTrigger,
      max_month: patch.customerRewardMaxPerMonth != null
        ? Number(patch.customerRewardMaxPerMonth)
        : current.customerRewardMaxPerMonth,
      tds_rate: patch.agentCommissionTdsRate != null
        ? Number(patch.agentCommissionTdsRate)
        : current.agentCommissionTdsRate,
    },
  );
  return getReferralSettings(pool);
}

function mapAttribution(row) {
  if (!row) return null;
  return {
    id: row.id,
    publicId: row.public_id,
    referralType: row.referral_type,
    referrerUserId: row.referrer_user_id,
    referrerCode: row.referrer_code,
    referredUserId: row.referred_user_id,
    leadId: row.lead_id,
    clickId: row.click_id,
    status: row.status,
    fraudFlag: row.fraud_flag,
    fraudNotes: row.fraud_notes,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function createAttribution(pool, {
  referralType,
  referrerUserId,
  referrerCode,
  clickId = null,
  landingPage = null,
  sourceUrl = null,
  utmSource = null,
  utmMedium = null,
  status = 'clicked',
  fraudFlag = null,
  fraudNotes = null,
}) {
  const settings = await getReferralSettings(pool);
  const id = newId();
  const publicId = await nextPublicId(pool, 'REF');
  const expiresAt = addDays(new Date(), settings.attributionWindowDays);
  await pool.execute(
    `INSERT INTO referral_attributions (
       id, public_id, referral_type, referrer_user_id, referrer_code, click_id,
       status, fraud_flag, fraud_notes, landing_page, source_url, utm_source, utm_medium, expires_at
     ) VALUES (
       :id, :public_id, :referral_type, :referrer_user_id, :referrer_code, :click_id,
       :status, :fraud_flag, :fraud_notes, :landing_page, :source_url, :utm_source, :utm_medium, :expires_at
     )`,
    {
      id,
      public_id: publicId,
      referral_type: referralType,
      referrer_user_id: referrerUserId,
      referrer_code: referrerCode,
      click_id: clickId,
      status,
      fraud_flag: fraudFlag,
      fraud_notes: fraudNotes,
      landing_page: landingPage,
      source_url: sourceUrl,
      utm_source: utmSource,
      utm_medium: utmMedium,
      expires_at: expiresAt,
    },
  );
  const [[row]] = await pool.execute(`SELECT * FROM referral_attributions WHERE id = :id`, { id });
  return mapAttribution(row);
}

export async function recordReferralClick(pool, {
  code,
  program: programHint = null,
  landingUrl = null,
  sourceUrl = null,
  utmSource = null,
  utmMedium = null,
  utmCampaign = null,
  ip = null,
  deviceRef = null,
  sessionToken = null,
} = {}) {
  await ensureReferralEngineSchema(pool);
  const resolved = await resolveReferralCode(pool, code);
  if (!resolved?.ownerUserId) {
    const err = new Error('Invalid referral code');
    err.status = 400;
    throw err;
  }
  const program = normalizeReferralProgram(programHint)
    || normalizeReferralProgram(resolved.program)
    || 'customer';
  const clickId = newId();
  const token = sessionToken || randomUUID().replace(/-/g, '').slice(0, 32);
  await pool.execute(
    `INSERT INTO referral_clicks (
       id, referral_code, program, referrer_user_id, landing_url, source_url,
       utm_source, utm_medium, utm_campaign, ip_hash, device_ref, session_token
     ) VALUES (
       :id, :referral_code, :program, :referrer_user_id, :landing_url, :source_url,
       :utm_source, :utm_medium, :utm_campaign, :ip_hash, :device_ref, :session_token
     )`,
    {
      id: clickId,
      referral_code: resolved.code,
      program,
      referrer_user_id: resolved.ownerUserId,
      landing_url: landingUrl,
      source_url: sourceUrl,
      utm_source: utmSource,
      utm_medium: utmMedium,
      utm_campaign: utmCampaign,
      ip_hash: hashIp(ip),
      device_ref: deviceRef,
      session_token: token,
    },
  );

  const referralType =
    program === 'agent' || resolved.ownerRole === 'agent' || /^RFA([-\s]|$)/i.test(String(resolved.code || ''))
      ? 'agent'
      : 'customer';

  const attribution = await createAttribution(pool, {
    referralType,
    referrerUserId: resolved.ownerUserId,
    referrerCode: resolved.code,
    clickId,
    landingPage: landingUrl,
    sourceUrl,
    utmSource,
    utmMedium,
  });

  const settings = await getReferralSettings(pool);
  return {
    clickId,
    sessionToken: token,
    attributionId: attribution.id,
    publicId: attribution.publicId,
    referralCode: resolved.code,
    referralType: attribution.referralType,
    referrerUserId: resolved.ownerUserId,
    program,
    attributionWindowDays: settings.attributionWindowDays,
    expiresAt: attribution.expiresAt,
  };
}

/**
 * Share-form invites should appear in Referral performance immediately as leads.
 */
export async function createInviteLeadAttribution(pool, {
  referrerUserId,
  referrerCode,
  program = 'customer',
  referredName = null,
  referredEmail = null,
  referredPhone = null,
  channel = 'share',
} = {}) {
  if (!referrerUserId || !referrerCode) return null;
  await ensureReferralEngineSchema(pool);
  const referralType =
    program === 'agent' || /^RFA([-\s]|$)/i.test(String(referrerCode || ''))
      ? 'agent'
      : 'customer';

  return createAttribution(pool, {
    referralType,
    referrerUserId,
    referrerCode,
    status: 'lead',
    landingPage: channel ? `invite:${channel}` : 'invite',
    sourceUrl: [referredName, referredEmail, referredPhone].filter(Boolean).join(' | ') || null,
  });
}

export async function resolveActiveAttribution(pool, {
  attributionId = null,
  referralCode = null,
  referredUserId = null,
  sessionToken = null,
} = {}) {
  await ensureReferralEngineSchema(pool);

  if (referredUserId) {
    const [[existing]] = await pool.execute(
      `SELECT * FROM referral_attributions
       WHERE referred_user_id = :uid
         AND status NOT IN ('expired', 'rejected')
       ORDER BY created_at ASC
       LIMIT 1`,
      { uid: referredUserId },
    );
    if (existing) {
      if (existing.expires_at && new Date(existing.expires_at) < new Date()
        && !['disbursed', 'reward_eligible', 'reward_pending', 'reward_paid'].includes(existing.status)) {
        await pool.execute(
          `UPDATE referral_attributions SET status = 'expired', updated_at = NOW() WHERE id = :id`,
          { id: existing.id },
        );
        return null;
      }
      return mapAttribution(existing);
    }
  }

  if (attributionId) {
    const [[row]] = await pool.execute(
      `SELECT * FROM referral_attributions WHERE id = :id LIMIT 1`,
      { id: attributionId },
    );
    if (row) return mapAttribution(row);
  }

  if (sessionToken) {
    const [[click]] = await pool.execute(
      `SELECT * FROM referral_clicks WHERE session_token = :token ORDER BY created_at DESC LIMIT 1`,
      { token: sessionToken },
    );
    if (click?.id) {
      const [[attr]] = await pool.execute(
        `SELECT * FROM referral_attributions WHERE click_id = :click_id ORDER BY created_at DESC LIMIT 1`,
        { click_id: click.id },
      );
      if (attr) return mapAttribution(attr);
    }
  }

  if (referralCode) {
    const resolved = await resolveReferralCode(pool, referralCode);
    if (!resolved) return null;
    return {
      id: null,
      publicId: null,
      referralType: resolved.program === 'agent' || resolved.ownerRole === 'agent' ? 'agent' : 'customer',
      referrerUserId: resolved.ownerUserId,
      referrerCode: resolved.code,
      status: 'clicked',
      provisional: true,
    };
  }

  return null;
}

async function flagFraud(pool, attributionId, flag, notes) {
  await pool.execute(
    `UPDATE referral_attributions SET
       status = 'fraud_suspected',
       fraud_flag = :flag,
       fraud_notes = :notes,
       updated_at = NOW()
     WHERE id = :id`,
    { id: attributionId, flag, notes: notes || null },
  );
}

export async function attachAttributionToUser(pool, userId, body = {}) {
  if (!userId) return null;
  await ensureReferralEngineSchema(pool);
  const settings = await getReferralSettings(pool);

  const [[profile]] = await pool.execute(
    `SELECT id, email, phone, referral_id, referrer_id, role FROM user_profiles WHERE id = :id LIMIT 1`,
    { id: userId },
  );
  if (!profile) return null;

  if (profile.referral_id && settings.existingCustomerPolicy === 'retain_original') {
    return resolveActiveAttribution(pool, { attributionId: profile.referral_id, referredUserId: userId });
  }

  let attribution = await resolveActiveAttribution(pool, {
    attributionId: body.referralId || body.referral_id || body.attributionId,
    referralCode: body.referralCode || body.referral_code,
    sessionToken: body.referralSessionToken || body.sessionToken,
    referredUserId: userId,
  });

  if (!attribution || attribution.provisional) {
    const code = body.referralCode || body.referral_code || attribution?.referrerCode;
    if (!code) return null;
    const click = await recordReferralClick(pool, {
      code,
      program: body.referralProgram || body.referral_program,
      landingUrl: body.landingUrl || null,
    });
    attribution = await resolveActiveAttribution(pool, { attributionId: click.attributionId });
  }

  if (!attribution?.id) return null;

  if (attribution.referrerUserId === userId) {
    await flagFraud(pool, attribution.id, 'self_referral', 'User attempted to refer themselves');
    return { ...attribution, status: 'fraud_suspected', fraudFlag: 'self_referral' };
  }

  const phone = String(body.phone || profile.phone || '').replace(/\D/g, '').slice(-10);
  const email = String(body.email || profile.email || '').trim().toLowerCase();
  if (phone || email) {
    const [[dup]] = await pool.execute(
      `SELECT ra.id
       FROM referral_attributions ra
       JOIN user_profiles up ON up.id = ra.referred_user_id
       WHERE ra.referrer_user_id = :referrer
         AND ra.id <> :attr_id
         AND ra.referred_user_id IS NOT NULL
         AND (
           (:phone <> '' AND RIGHT(REGEXP_REPLACE(COALESCE(up.phone, ''), '\\D', '', 'g'), 10) = :phone)
           OR (:email <> '' AND LOWER(COALESCE(up.email, '')) = :email)
         )
       LIMIT 1`,
      {
        referrer: attribution.referrerUserId,
        attr_id: attribution.id,
        phone: phone || '',
        email: email || '',
      },
    ).catch(() => [[null]]);
    if (dup?.id) {
      await flagFraud(pool, attribution.id, 'duplicate_contact', 'Duplicate phone/email under same referrer');
      return { ...attribution, status: 'fraud_suspected', fraudFlag: 'duplicate_contact' };
    }
  }

  await pool.execute(
    `UPDATE referral_attributions SET
       referred_user_id = :uid,
       status = CASE
         WHEN status IN ('clicked') THEN 'registered'
         ELSE status
       END,
       registered_at = COALESCE(registered_at, NOW()),
       updated_at = NOW()
     WHERE id = :id`,
    { id: attribution.id, uid: userId },
  );

  try {
    await pool.execute(
      `UPDATE user_profiles SET
         referral_id = COALESCE(referral_id, :referral_id),
         referral_type = COALESCE(referral_type, :referral_type),
         referrer_id = COALESCE(referrer_id, :referrer_id),
         referred_at = COALESCE(referred_at, NOW())
       WHERE id = :uid`,
      {
        uid: userId,
        referral_id: attribution.id,
        referral_type: attribution.referralType,
        referrer_id: attribution.referrerCode,
      },
    );
  } catch {
    /* columns may be missing on older DBs until ensure runs */
  }

  return resolveActiveAttribution(pool, { attributionId: attribution.id });
}

export async function attachAttributionToLead(pool, leadId, body = {}) {
  if (!leadId) return null;
  await ensureReferralEngineSchema(pool);

  let attribution = null;
  if (body.referralId || body.referral_id) {
    attribution = await resolveActiveAttribution(pool, {
      attributionId: body.referralId || body.referral_id,
    });
  }

  const userId = body.customerId || body.customer_id || body.userId || body.user_id;
  if (!attribution && userId) {
    attribution = await attachAttributionToUser(pool, userId, body);
  }

  if (!attribution && (body.referralCode || body.referral_code || body.sourcedAgentCode || body.sourced_agent_code)) {
    const code = body.referralCode || body.referral_code || body.sourcedAgentCode || body.sourced_agent_code;
    const click = await recordReferralClick(pool, {
      code,
      program: body.referralProgram || body.referral_program,
    }).catch(() => null);
    if (click?.attributionId) {
      attribution = await resolveActiveAttribution(pool, { attributionId: click.attributionId });
    }
  }

  if (attribution?.id) {
    await pool.execute(
      `UPDATE referral_attributions SET
         lead_id = COALESCE(lead_id, :lead_id),
         status = CASE WHEN status IN ('clicked', 'registered') THEN 'lead' ELSE status END,
         lead_created_at = COALESCE(lead_created_at, NOW()),
         updated_at = NOW()
       WHERE id = :id`,
      { id: attribution.id, lead_id: leadId },
    );
  }

  return attribution;
}

export async function attachAttributionToApplication(pool, applicationId, body = {}) {
  if (!applicationId) return null;
  await ensureReferralEngineSchema(pool);

  const [[app]] = await pool.execute(
    `SELECT id, customer_id, referral_id, sourced_agent_code, status, data
     FROM loan_applications WHERE id = :id LIMIT 1`,
    { id: applicationId },
  );
  if (!app) return null;

  let attribution = null;
  if (app.referral_id) {
    attribution = await resolveActiveAttribution(pool, { attributionId: app.referral_id });
  }

  if (!attribution && app.customer_id) {
    attribution = await resolveActiveAttribution(pool, { referredUserId: app.customer_id });
    if (!attribution) {
      attribution = await attachAttributionToUser(pool, app.customer_id, body);
    }
  }

  if (!attribution) {
    const code = body.referralCode
      || body.referral_code
      || body.sourcedAgentCode
      || body.sourced_agent_code
      || app.sourced_agent_code;
    if (code) {
      const click = await recordReferralClick(pool, {
        code,
        program: body.referralProgram || body.referral_program,
      }).catch(() => null);
      if (click?.attributionId) {
        attribution = await resolveActiveAttribution(pool, { attributionId: click.attributionId });
        if (app.customer_id && attribution) {
          await attachAttributionToUser(pool, app.customer_id, {
            ...body,
            referralId: attribution.id,
          });
        }
      }
    }
  }

  if (!attribution?.id) return null;

  const appStatus = String(app.status || '').toLowerCase();
  let nextStatus = 'application';
  if (['submitted', 'under_review', 'documents_pending'].includes(appStatus)) nextStatus = 'submitted';
  if (appStatus === 'approved') nextStatus = 'approved';
  if (appStatus === 'disbursed') nextStatus = 'disbursed';

  await pool.execute(
    `UPDATE referral_attributions SET
       status = CASE
         WHEN status IN ('expired', 'fraud_suspected', 'rejected') THEN status
         ELSE :next_status
       END,
       application_started_at = COALESCE(application_started_at, NOW()),
       submitted_at = CASE WHEN :stamp_submitted = 1
         THEN COALESCE(submitted_at, NOW()) ELSE submitted_at END,
       approved_at = CASE WHEN :stamp_approved = 1
         THEN COALESCE(approved_at, NOW()) ELSE approved_at END,
       disbursed_at = CASE WHEN :stamp_disbursed = 1
         THEN COALESCE(disbursed_at, NOW()) ELSE disbursed_at END,
       updated_at = NOW()
     WHERE id = :id`,
    {
      id: attribution.id,
      next_status: canAdvance(attribution.status, nextStatus) ? nextStatus : attribution.status,
      stamp_submitted: ['submitted', 'approved', 'disbursed'].includes(nextStatus) ? 1 : 0,
      stamp_approved: ['approved', 'disbursed'].includes(nextStatus) ? 1 : 0,
      stamp_disbursed: nextStatus === 'disbursed' ? 1 : 0,
    },
  );

  try {
    await pool.execute(
      `UPDATE loan_applications SET
         referral_id = COALESCE(referral_id, :referral_id),
         referral_type = COALESCE(referral_type, :referral_type),
         referrer_id = COALESCE(referrer_id, :referrer_id),
         sourced_agent_code = COALESCE(
           sourced_agent_code,
           CASE WHEN :referral_type = 'agent' THEN :referrer_id ELSE NULL END
         )
       WHERE id = :app_id`,
      {
        app_id: applicationId,
        referral_id: attribution.id,
        referral_type: attribution.referralType,
        referrer_id: attribution.referrerCode,
      },
    );
  } catch {
    /* ignore */
  }

  return resolveActiveAttribution(pool, { attributionId: attribution.id });
}

export async function advanceAttributionLifecycle(pool, attributionId, status, timestamps = {}) {
  await ensureReferralEngineSchema(pool);
  const [[row]] = await pool.execute(
    `SELECT * FROM referral_attributions WHERE id = :id LIMIT 1`,
    { id: attributionId },
  );
  if (!row || !canAdvance(row.status, status)) return mapAttribution(row);

  const sets = ['status = :status', 'updated_at = NOW()'];
  const params = { id: attributionId, status };
  const stampMap = {
    registered: 'registered_at',
    lead: 'lead_created_at',
    application: 'application_started_at',
    submitted: 'submitted_at',
    approved: 'approved_at',
    disbursed: 'disbursed_at',
  };
  const col = stampMap[status];
  if (col) {
    sets.push(`${col} = COALESCE(${col}, :stamp)`);
    params.stamp = timestamps[col] || new Date().toISOString();
  }
  await pool.execute(
    `UPDATE referral_attributions SET ${sets.join(', ')} WHERE id = :id`,
    params,
  );
  const [[updated]] = await pool.execute(
    `SELECT * FROM referral_attributions WHERE id = :id`,
    { id: attributionId },
  );
  return mapAttribution(updated);
}

async function loadActiveRewardRule(pool, referralType) {
  const [[rule]] = await pool.execute(
    `SELECT * FROM referral_reward_rules
     WHERE is_active = TRUE
       AND referral_type = :type
     ORDER BY created_at DESC
     LIMIT 1`,
    { type: referralType || 'customer' },
  );
  if (rule) return rule;
  const settings = await getReferralSettings(pool);
  return {
    reward_type: settings.customerRewardType,
    reward_value: settings.customerRewardAmount,
    min_disbursement: settings.customerRewardMinDisbursement,
    max_rewards_per_month: settings.customerRewardMaxPerMonth,
    qualifying_event: settings.customerRewardTrigger,
  };
}

async function countMonthlyRewards(pool, referrerUserId) {
  const [[row]] = await pool.execute(
    `SELECT COUNT(*)::int AS c
     FROM referral_transactions
     WHERE referrer_user_id = :uid
       AND referral_type = 'customer'
       AND payment_status NOT IN ('rejected', 'ineligible')
       AND created_at >= date_trunc('month', NOW())`,
    { uid: referrerUserId },
  );
  return Number(row?.c || 0);
}

/**
 * Create/update referral_transactions on disbursement as Pending Verification.
 */
export async function evaluateReferralPayout(pool, applicationId) {
  if (!applicationId) return null;
  await ensureReferralEngineSchema(pool);

  const [[app]] = await pool.execute(
    `SELECT la.*, b.name AS bank_name
     FROM loan_applications la
     LEFT JOIN banks b ON b.id = la.selected_bank_id
     WHERE la.id = :id
     LIMIT 1`,
    { id: applicationId },
  );
  if (!app) return null;

  const status = String(app.status || '').toLowerCase();
  if (status !== 'disbursed') {
    if (app.referral_id) {
      await advanceAttributionLifecycle(
        pool,
        app.referral_id,
        status === 'approved' ? 'approved' : status === 'submitted' ? 'submitted' : 'application',
      );
    } else {
      await attachAttributionToApplication(pool, applicationId, {});
    }
    return null;
  }

  let attribution = await attachAttributionToApplication(pool, applicationId, {});
  if (!attribution?.id) return null;
  if (['fraud_suspected', 'expired', 'rejected'].includes(attribution.status)) {
    return { attribution, transactions: [], skipped: attribution.status };
  }

  await advanceAttributionLifecycle(pool, attribution.id, 'disbursed');

  const data = parseJson(app.data);
  const disbursedAmount = Number(
    app.disbursed_amount
    || data.disbursed_amount
    || data.disbursedAmount
    || data.requested_loan_amount
    || data.loan_amount
    || 0,
  );
  const product = data.loan_type || data.loan_purpose || data.product || 'loan';
  const lender = app.bank_name || data.bank_name || data.lender || null;
  const settings = await getReferralSettings(pool);
  const created = [];

  // Agent commission transaction
  if (attribution.referralType === 'agent' || attribution.referrerUserId) {
    const isAgentRef = attribution.referralType === 'agent'
      || /^RFA([-\s]|$)/i.test(String(attribution.referrerCode || ''));

    if (isAgentRef) {
      const [[existingAgent]] = await pool.execute(
        `SELECT * FROM referral_transactions
         WHERE application_id = :app_id AND referral_type = 'agent'
         LIMIT 1`,
        { app_id: applicationId },
      );

      if (!existingAgent) {
        const config = await resolveAgentCommissionConfig(pool, attribution.referrerUserId, product);
        const commissionAmount = calculateCommissionFromAmount({
          amount: disbursedAmount,
          config,
        });
        const rate = config?.commission_type === 'fixed'
          ? null
          : Number(config?.commission_value ?? 0);
        const tdsRate = settings.agentCommissionTdsRate;
        const tds = Math.round(commissionAmount * tdsRate);
        const net = commissionAmount - tds;
        const eligible = disbursedAmount >= 100000 && commissionAmount > 0;
        const id = newId();
        const publicId = await nextPublicId(pool, 'RTXN');
        await pool.execute(
          `INSERT INTO referral_transactions (
             id, public_id, attribution_id, referral_type, referrer_user_id, referred_user_id,
             application_id, product, lender, disbursed_amount, commission_rate, commission_amount,
             reward_amount, tds_amount, net_amount, eligibility_status, payment_status
           ) VALUES (
             :id, :public_id, :attribution_id, 'agent', :referrer_user_id, :referred_user_id,
             :application_id, :product, :lender, :disbursed_amount, :commission_rate, :commission_amount,
             0, :tds_amount, :net_amount, :eligibility_status, :payment_status
           )`,
          {
            id,
            public_id: publicId,
            attribution_id: attribution.id,
            referrer_user_id: attribution.referrerUserId,
            referred_user_id: attribution.referredUserId || app.customer_id,
            application_id: applicationId,
            product,
            lender,
            disbursed_amount: disbursedAmount,
            commission_rate: rate,
            commission_amount: commissionAmount,
            tds_amount: tds,
            net_amount: net,
            eligibility_status: eligible ? 'eligible' : 'ineligible',
            payment_status: eligible ? 'pending_verification' : 'ineligible',
          },
        );
        const [[row]] = await pool.execute(
          `SELECT * FROM referral_transactions WHERE id = :id`,
          { id },
        );
        created.push(row);
      } else {
        created.push(existingAgent);
      }
    }
  }

  // Customer reward transaction (referrer is customer)
  if (attribution.referralType === 'customer') {
    const [[existingReward]] = await pool.execute(
      `SELECT * FROM referral_transactions
       WHERE application_id = :app_id AND referral_type = 'customer'
       LIMIT 1`,
      { app_id: applicationId },
    );

    if (!existingReward) {
      const rule = await loadActiveRewardRule(pool, 'customer');
      const minDisb = Number(rule.min_disbursement ?? 200000);
      const maxMonth = Number(rule.max_rewards_per_month ?? 10);
      const monthlyCount = await countMonthlyRewards(pool, attribution.referrerUserId);
      let rewardAmount = rule.reward_type === 'percentage'
        ? Math.round((disbursedAmount * Number(rule.reward_value || 0)) / 100)
        : Number(rule.reward_value || 1000);
      let eligibility = 'eligible';
      let paymentStatus = 'pending_verification';
      let notes = null;
      if (disbursedAmount < minDisb) {
        eligibility = 'ineligible';
        paymentStatus = 'ineligible';
        notes = `Disbursement below minimum ₹${minDisb}`;
        rewardAmount = 0;
      } else if (monthlyCount >= maxMonth) {
        eligibility = 'capped';
        paymentStatus = 'ineligible';
        notes = `Monthly reward cap (${maxMonth}) reached`;
        rewardAmount = 0;
      }

      const id = newId();
      const publicId = await nextPublicId(pool, 'RTXN');
      await pool.execute(
        `INSERT INTO referral_transactions (
           id, public_id, attribution_id, referral_type, referrer_user_id, referred_user_id,
           application_id, product, lender, disbursed_amount, commission_rate, commission_amount,
           reward_amount, tds_amount, net_amount, eligibility_status, payment_status, notes
         ) VALUES (
           :id, :public_id, :attribution_id, 'customer', :referrer_user_id, :referred_user_id,
           :application_id, :product, :lender, :disbursed_amount, NULL, 0,
           :reward_amount, 0, :net_amount, :eligibility_status, :payment_status, :notes
         )`,
        {
          id,
          public_id: publicId,
          attribution_id: attribution.id,
          referrer_user_id: attribution.referrerUserId,
          referred_user_id: attribution.referredUserId || app.customer_id,
          application_id: applicationId,
          product,
          lender,
          disbursed_amount: disbursedAmount,
          reward_amount: rewardAmount,
          net_amount: rewardAmount,
          eligibility_status: eligibility,
          payment_status: paymentStatus,
          notes,
        },
      );
      const [[row]] = await pool.execute(
        `SELECT * FROM referral_transactions WHERE id = :id`,
        { id },
      );
      created.push(row);
    } else {
      created.push(existingReward);
    }
  }

  if (created.some((t) => t.payment_status === 'pending_verification' || t.eligibility_status === 'eligible')) {
    await advanceAttributionLifecycle(pool, attribution.id, 'reward_eligible');
  }

  return { attribution, transactions: created };
}

export async function getReferrerPerformanceMetrics(pool, referrerUserId, program = null) {
  await ensureReferralEngineSchema(pool);
  const typeFilter = program === 'agent' ? 'agent' : program === 'customer' ? 'customer' : null;
  const params = { uid: referrerUserId };
  let typeClause = '';
  let programClause = '';
  if (typeFilter) {
    typeClause = ' AND referral_type = :rtype';
    params.rtype = typeFilter;
  }
  if (program === 'agent' || program === 'customer') {
    programClause = ' AND program = :program';
    params.program = program;
  }

  const [[clicks]] = await pool.execute(
    `SELECT COUNT(*)::int AS c FROM referral_clicks
     WHERE referrer_user_id = :uid${programClause}`,
    params,
  );

  const inviteParams = { uid: referrerUserId };
  let inviteProgramClause = '';
  if (program === 'agent' || program === 'customer') {
    inviteProgramClause = ' AND program = :program';
    inviteParams.program = program;
  }
  const [[invites]] = await pool.execute(
    `SELECT COUNT(*)::int AS c FROM referral_invites
     WHERE referrer_user_id = :uid${inviteProgramClause}`,
    inviteParams,
  );

  const [[funnel]] = await pool.execute(
    `SELECT
       COUNT(*)::int AS attributions,
       COUNT(*) FILTER (WHERE status IN ('registered', 'lead', 'application', 'submitted', 'approved', 'disbursed', 'reward_eligible', 'reward_pending', 'reward_paid'))::int AS leads,
       COUNT(*) FILTER (WHERE status IN ('application', 'submitted', 'approved', 'disbursed', 'reward_eligible', 'reward_pending', 'reward_paid'))::int AS applications,
       COUNT(*) FILTER (WHERE status IN ('approved', 'disbursed', 'reward_eligible', 'reward_pending', 'reward_paid'))::int AS approved,
       COUNT(*) FILTER (WHERE status IN ('disbursed', 'reward_eligible', 'reward_pending', 'reward_paid'))::int AS disbursed,
       COUNT(*) FILTER (WHERE status = 'clicked')::int AS clicked_only
     FROM referral_attributions
     WHERE referrer_user_id = :uid${typeClause}`,
    params,
  );

  const mktParams = { uid: referrerUserId };
  let mktProgramClause = '';
  if (program === 'agent' || program === 'customer') {
    mktProgramClause = ' AND referral_program = :program';
    mktParams.program = program;
  }
  let marketingLeads = 0;
  try {
    const [[mkt]] = await pool.execute(
      `SELECT COUNT(*)::int AS c FROM marketing_leads
       WHERE referred_by_user_id = :uid${mktProgramClause}`,
      mktParams,
    );
    marketingLeads = Number(mkt?.c || 0);
  } catch {
    marketingLeads = 0;
  }

  const [[money]] = await pool.execute(
    `SELECT
       COALESCE(SUM(disbursed_amount), 0)::float AS total_disbursed,
       COALESCE(SUM(CASE WHEN referral_type = 'agent' THEN commission_amount ELSE reward_amount END), 0)::float AS earned,
       COALESCE(SUM(CASE WHEN payment_status IN ('pending_verification', 'verified', 'approved', 'payable')
         THEN CASE WHEN referral_type = 'agent' THEN commission_amount ELSE reward_amount END ELSE 0 END), 0)::float AS pending,
       COALESCE(SUM(CASE WHEN payment_status = 'paid'
         THEN CASE WHEN referral_type = 'agent' THEN commission_amount ELSE reward_amount END ELSE 0 END), 0)::float AS paid
     FROM referral_transactions
     WHERE referrer_user_id = :uid${typeClause}`,
    params,
  );

  const attributionLeads = Number(funnel?.leads || 0);
  const inviteLeads = Number(invites?.c || 0);
  // Invites and marketing leads should surface immediately; avoid under-counting when
  // attribution rows lag behind share-form invites.
  const leads = Math.max(attributionLeads, inviteLeads, marketingLeads);

  return {
    clicks: Number(clicks?.c || 0),
    leads,
    applications: Number(funnel?.applications || 0),
    approved: Number(funnel?.approved || 0),
    disbursed: Number(funnel?.disbursed || 0),
    totalDisbursed: Number(money?.total_disbursed || 0),
    earned: Number(money?.earned || 0),
    pending: Number(money?.pending || 0),
    paid: Number(money?.paid || 0),
    attributions: Number(funnel?.attributions || 0),
    invites: inviteLeads,
    marketingLeads,
  };
}

export async function listReferralAttributions(pool, filters = {}) {
  await ensureReferralEngineSchema(pool);
  const conditions = ['1=1'];
  const params = {};
  if (filters.referralType) {
    conditions.push('ra.referral_type = :rtype');
    params.rtype = filters.referralType;
  }
  if (filters.status) {
    conditions.push('ra.status = :status');
    params.status = filters.status;
  }
  if (filters.fraudOnly) {
    conditions.push(`(ra.status = 'fraud_suspected' OR ra.fraud_flag IS NOT NULL)`);
  }
  if (filters.referrerUserId) {
    conditions.push('ra.referrer_user_id = :referrer');
    params.referrer = filters.referrerUserId;
  }
  const limit = Math.min(Number(filters.limit) || 100, 500);
  params.limit = limit;

  const [rows] = await pool.execute(
    `SELECT ra.*,
       ref.full_name AS referrer_name, ref.email AS referrer_email,
       ree.full_name AS referred_name, ree.email AS referred_email
     FROM referral_attributions ra
     LEFT JOIN user_profiles ref ON ref.id = ra.referrer_user_id
     LEFT JOIN user_profiles ree ON ree.id = ra.referred_user_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY ra.created_at DESC
     LIMIT :limit`,
    params,
  );
  return rows;
}

export async function listReferralTransactions(pool, filters = {}) {
  await ensureReferralEngineSchema(pool);
  const conditions = ['1=1'];
  const params = {};
  if (filters.referrerUserId) {
    conditions.push('rt.referrer_user_id = :referrer');
    params.referrer = filters.referrerUserId;
  }
  if (filters.paymentStatus) {
    conditions.push('rt.payment_status = :pstatus');
    params.pstatus = filters.paymentStatus;
  }
  if (filters.referralType) {
    conditions.push('rt.referral_type = :rtype');
    params.rtype = filters.referralType;
  }
  if (filters.from) {
    conditions.push('rt.created_at >= :from');
    params.from = filters.from;
  }
  if (filters.to) {
    conditions.push('rt.created_at <= :to');
    params.to = `${filters.to} 23:59:59`;
  }
  if (filters.payableOnly) {
    conditions.push(`rt.payment_status IN ('approved', 'payable')`);
  }
  const limit = Math.min(Number(filters.limit) || 200, 1000);
  params.limit = limit;

  const [rows] = await pool.execute(
    `SELECT rt.*,
       up.full_name AS referrer_name,
       la.application_number
     FROM referral_transactions rt
     LEFT JOIN user_profiles up ON up.id = rt.referrer_user_id
     LEFT JOIN loan_applications la ON la.id = rt.application_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY rt.created_at DESC
     LIMIT :limit`,
    params,
  );
  return rows;
}

export async function updateReferralTransactionStatus(pool, transactionId, paymentStatus, { notes, actorId } = {}) {
  await ensureReferralEngineSchema(pool);
  if (!PAYMENT_STATUSES.has(paymentStatus)) {
    const err = new Error('Invalid payment status');
    err.status = 400;
    throw err;
  }
  await pool.execute(
    `UPDATE referral_transactions SET
       payment_status = :status,
       notes = COALESCE(:notes, notes),
       paid_at = CASE WHEN :status = 'paid' THEN COALESCE(paid_at, NOW()) ELSE paid_at END,
       updated_at = NOW()
     WHERE id = :id`,
    { id: transactionId, status: paymentStatus, notes: notes || null },
  );
  if (actorId) {
    try {
      const { writeAuditLog } = await import('./audit.js');
      await writeAuditLog({
        userId: actorId,
        actionType: 'UPDATE',
        tableName: 'referral_transactions',
        recordId: transactionId,
        newValues: { payment_status: paymentStatus, notes },
      });
    } catch {
      /* ignore */
    }
  }
  const [[row]] = await pool.execute(
    `SELECT * FROM referral_transactions WHERE id = :id`,
    { id: transactionId },
  );
  return row;
}

export async function overrideAttributionFraud(pool, attributionId, { clear = false, notes, actorId } = {}) {
  await ensureReferralEngineSchema(pool);
  if (clear) {
    await pool.execute(
      `UPDATE referral_attributions SET
         status = CASE WHEN status = 'fraud_suspected' THEN 'registered' ELSE status END,
         fraud_flag = NULL,
         fraud_notes = COALESCE(:notes, fraud_notes),
         updated_at = NOW()
       WHERE id = :id`,
      { id: attributionId, notes: notes || 'Fraud cleared by admin' },
    );
  } else {
    await flagFraud(pool, attributionId, 'manual_review', notes || 'Flagged by admin');
  }
  if (actorId) {
    try {
      const { writeAuditLog } = await import('./audit.js');
      await writeAuditLog({
        userId: actorId,
        actionType: 'UPDATE',
        tableName: 'referral_attributions',
        recordId: attributionId,
        newValues: { clear, notes },
      });
    } catch {
      /* ignore */
    }
  }
  return resolveActiveAttribution(pool, { attributionId });
}

export async function getAdminReferralDashboard(pool) {
  await ensureReferralEngineSchema(pool);
  const [[funnel]] = await pool.execute(
    `SELECT
       (SELECT COUNT(*)::int FROM referral_clicks) AS clicks,
       COUNT(*) FILTER (WHERE status = 'registered')::int AS registered,
       COUNT(*) FILTER (WHERE status IN ('lead', 'application', 'submitted', 'approved', 'disbursed', 'reward_eligible', 'reward_pending', 'reward_paid'))::int AS leads,
       COUNT(*) FILTER (WHERE status IN ('application', 'submitted', 'approved', 'disbursed', 'reward_eligible', 'reward_pending', 'reward_paid'))::int AS applications,
       COUNT(*) FILTER (WHERE status IN ('approved', 'disbursed', 'reward_eligible', 'reward_pending', 'reward_paid'))::int AS approved,
       COUNT(*) FILTER (WHERE status IN ('disbursed', 'reward_eligible', 'reward_pending', 'reward_paid'))::int AS disbursed,
       COUNT(*) FILTER (WHERE status = 'fraud_suspected' OR fraud_flag IS NOT NULL)::int AS fraud
     FROM referral_attributions`,
  );
  const [[money]] = await pool.execute(
    `SELECT
       COALESCE(SUM(CASE WHEN payment_status = 'pending_verification' THEN commission_amount + reward_amount ELSE 0 END), 0)::float AS pending_verification,
       COALESCE(SUM(CASE WHEN payment_status IN ('verified', 'approved', 'payable') THEN commission_amount + reward_amount ELSE 0 END), 0)::float AS awaiting_payout,
       COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN commission_amount + reward_amount ELSE 0 END), 0)::float AS paid
     FROM referral_transactions`,
  );
  return {
    funnel: {
      clicks: Number(funnel?.clicks || 0),
      registered: Number(funnel?.registered || 0),
      leads: Number(funnel?.leads || 0),
      applications: Number(funnel?.applications || 0),
      approved: Number(funnel?.approved || 0),
      disbursed: Number(funnel?.disbursed || 0),
      fraud: Number(funnel?.fraud || 0),
    },
    money: {
      pendingVerification: Number(money?.pending_verification || 0),
      awaitingPayout: Number(money?.awaiting_payout || 0),
      paid: Number(money?.paid || 0),
    },
  };
}

export async function listCommissionRules(pool) {
  await ensureReferralEngineSchema(pool);
  const [rows] = await pool.execute(
    `SELECT * FROM referral_commission_rules ORDER BY created_at DESC`,
  );
  return rows;
}

export async function listRewardRules(pool) {
  await ensureReferralEngineSchema(pool);
  const [rows] = await pool.execute(
    `SELECT * FROM referral_reward_rules ORDER BY created_at DESC`,
  );
  return rows;
}

export async function upsertCommissionRule(pool, input = {}) {
  await ensureReferralEngineSchema(pool);
  const id = input.id || newId();
  if (input.id) {
    await pool.execute(
      `UPDATE referral_commission_rules SET
         product = :product,
         lender = :lender,
         agent_type = :agent_type,
         commission_type = :commission_type,
         commission_value = :commission_value,
         min_disbursement = :min_disbursement,
         max_commission = :max_commission,
         trigger_event = :trigger_event,
         tds_rate = :tds_rate,
         is_active = :is_active,
         updated_at = NOW()
       WHERE id = :id`,
      {
        id,
        product: input.product || null,
        lender: input.lender || null,
        agent_type: input.agentType || input.agent_type || null,
        commission_type: input.commissionType || input.commission_type || 'percentage',
        commission_value: Number(input.commissionValue ?? input.commission_value ?? 1),
        min_disbursement: Number(input.minDisbursement ?? input.min_disbursement ?? 100000),
        max_commission: input.maxCommission ?? input.max_commission ?? null,
        trigger_event: input.triggerEvent || input.trigger_event || 'disbursement',
        tds_rate: Number(input.tdsRate ?? input.tds_rate ?? 0.1),
        is_active: input.isActive !== false,
      },
    );
  } else {
    await pool.execute(
      `INSERT INTO referral_commission_rules (
         id, product, lender, agent_type, commission_type, commission_value,
         min_disbursement, max_commission, trigger_event, tds_rate, is_active
       ) VALUES (
         :id, :product, :lender, :agent_type, :commission_type, :commission_value,
         :min_disbursement, :max_commission, :trigger_event, :tds_rate, :is_active
       )`,
      {
        id,
        product: input.product || null,
        lender: input.lender || null,
        agent_type: input.agentType || input.agent_type || null,
        commission_type: input.commissionType || input.commission_type || 'percentage',
        commission_value: Number(input.commissionValue ?? input.commission_value ?? 1),
        min_disbursement: Number(input.minDisbursement ?? input.min_disbursement ?? 100000),
        max_commission: input.maxCommission ?? input.max_commission ?? null,
        trigger_event: input.triggerEvent || input.trigger_event || 'disbursement',
        tds_rate: Number(input.tdsRate ?? input.tds_rate ?? 0.1),
        is_active: input.isActive !== false,
      },
    );
  }
  const [[row]] = await pool.execute(
    `SELECT * FROM referral_commission_rules WHERE id = :id`,
    { id },
  );
  return row;
}

export async function upsertRewardRule(pool, input = {}) {
  await ensureReferralEngineSchema(pool);
  const id = input.id || newId();
  if (input.id) {
    await pool.execute(
      `UPDATE referral_reward_rules SET
         referral_type = :referral_type,
         qualifying_event = :qualifying_event,
         reward_type = :reward_type,
         reward_value = :reward_value,
         min_disbursement = :min_disbursement,
         max_rewards_per_month = :max_rewards_per_month,
         is_active = :is_active,
         updated_at = NOW()
       WHERE id = :id`,
      {
        id,
        referral_type: input.referralType || input.referral_type || 'customer',
        qualifying_event: input.qualifyingEvent || input.qualifying_event || 'disbursement',
        reward_type: input.rewardType || input.reward_type || 'fixed',
        reward_value: Number(input.rewardValue ?? input.reward_value ?? 1000),
        min_disbursement: Number(input.minDisbursement ?? input.min_disbursement ?? 200000),
        max_rewards_per_month: Number(input.maxRewardsPerMonth ?? input.max_rewards_per_month ?? 10),
        is_active: input.isActive !== false,
      },
    );
  } else {
    await pool.execute(
      `INSERT INTO referral_reward_rules (
         id, referral_type, qualifying_event, reward_type, reward_value,
         min_disbursement, max_rewards_per_month, is_active
       ) VALUES (
         :id, :referral_type, :qualifying_event, :reward_type, :reward_value,
         :min_disbursement, :max_rewards_per_month, :is_active
       )`,
      {
        id,
        referral_type: input.referralType || input.referral_type || 'customer',
        qualifying_event: input.qualifyingEvent || input.qualifying_event || 'disbursement',
        reward_type: input.rewardType || input.reward_type || 'fixed',
        reward_value: Number(input.rewardValue ?? input.reward_value ?? 1000),
        min_disbursement: Number(input.minDisbursement ?? input.min_disbursement ?? 200000),
        max_rewards_per_month: Number(input.maxRewardsPerMonth ?? input.max_rewards_per_month ?? 10),
        is_active: input.isActive !== false,
      },
    );
  }
  const [[row]] = await pool.execute(
    `SELECT * FROM referral_reward_rules WHERE id = :id`,
    { id },
  );
  return row;
}

export { normalizeReferralCode, normalizeReferralProgram };
