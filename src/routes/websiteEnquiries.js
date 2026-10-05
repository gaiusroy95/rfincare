import { Router } from 'express';
import { z } from 'zod';

import { getPool } from '../db/pool.js';
import { newId } from '../lib/ids.js';
import { sendEmail } from '../lib/email.js';
import { getSiteContactSettings } from '../lib/siteContactSettings.js';
import { authenticate } from '../middleware/authenticate.js';
import {
  assertEmployeeAccess,
  buildEffectiveEmployeeAccess,
  employeeHasModulePermission,
  fetchEmployeeAccessControlsMap,
} from '../lib/employeeAccessControls.js';
import { ensureContactInquirySchema, supportInboxes } from './contactInquiries.js';

/** Public, no-login enquiry submission (replaces website appointment booking). */
export const publicEnquiriesRouter = Router();
/** Admin + employee (Leads module) enquiry inbox. */
export const staffEnquiriesRouter = Router();

export const ENQUIRY_STATUSES = ['new', 'contacted', 'in_progress', 'converted', 'closed', 'spam'];

const TOPICS = [
  'Personal Loan',
  'Home Loan',
  'Business Loan',
  'Loan Against Property',
  'Credit cards',
  'Insurance',
  'Mutual Funds / SIP',
  'CIBIL / Credit score',
  'General financial advice',
  'Other',
];

let schemaReady = false;

async function ensureEnquirySchema() {
  if (schemaReady) return;
  await ensureContactInquirySchema();
  const pool = getPool();
  const statements = [
    `ALTER TABLE contact_inquiries ALTER COLUMN email DROP NOT NULL`,
    `ALTER TABLE contact_inquiries ADD COLUMN IF NOT EXISTS source VARCHAR(32) NOT NULL DEFAULT 'contact_us'`,
    `ALTER TABLE contact_inquiries ADD COLUMN IF NOT EXISTS city VARCHAR(120) NULL`,
    `ALTER TABLE contact_inquiries ADD COLUMN IF NOT EXISTS preferred_callback VARCHAR(120) NULL`,
    `ALTER TABLE contact_inquiries ADD COLUMN IF NOT EXISTS staff_remarks TEXT NULL`,
    `ALTER TABLE contact_inquiries ADD COLUMN IF NOT EXISTS handled_by VARCHAR(36) NULL`,
    `ALTER TABLE contact_inquiries ADD COLUMN IF NOT EXISTS handled_by_name VARCHAR(200) NULL`,
    `ALTER TABLE contact_inquiries ADD COLUMN IF NOT EXISTS handled_at TIMESTAMPTZ NULL`,
    `ALTER TABLE contact_inquiries ADD COLUMN IF NOT EXISTS submitter_ip VARCHAR(64) NULL`,
    `CREATE INDEX IF NOT EXISTS idx_contact_inquiries_created ON contact_inquiries (created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_contact_inquiries_status ON contact_inquiries (status)`,
    `CREATE TABLE IF NOT EXISTS contact_inquiry_actions (
       id VARCHAR(36) PRIMARY KEY,
       inquiry_id VARCHAR(36) NOT NULL,
       actor_user_id VARCHAR(36) NULL,
       actor_name VARCHAR(200) NULL,
       actor_role VARCHAR(32) NULL,
       status_from VARCHAR(32) NULL,
       status_to VARCHAR(32) NULL,
       remarks TEXT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_contact_inquiry_actions_inquiry
       ON contact_inquiry_actions (inquiry_id, created_at)`,
  ];
  for (const sql of statements) {
    await pool.execute(sql);
  }
  schemaReady = true;
}

function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.toString()?.split(',')?.[0]?.trim()
    || req.socket?.remoteAddress
    || null
  );
}

/* ---------- Abuse protection (no OTP / login by product decision) ---------- */

const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_IP = 6;
const MAX_PER_PHONE = 3;
const rateBuckets = new Map();

function hitRateLimit(key, max) {
  const now = Date.now();
  const hits = (rateBuckets.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= max) {
    rateBuckets.set(key, hits);
    return true;
  }
  hits.push(now);
  rateBuckets.set(key, hits);
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      if (!v.some((t) => now - t < RATE_WINDOW_MS)) rateBuckets.delete(k);
    }
  }
  return false;
}

const PublicEnquirySchema = z.object({
  fullName: z.string().trim().min(2, 'Enter your name').max(120),
  phone: z
    .string()
    .trim()
    .transform((v) => v.replace(/\D/g, '').slice(-10))
    .refine((v) => /^[6-9]\d{9}$/.test(v), 'Enter a valid 10-digit mobile number'),
  email: z
    .string()
    .trim()
    .max(255)
    .optional()
    .transform((v) => (v ? v.toLowerCase() : ''))
    .refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Enter a valid email'),
  city: z.string().trim().max(120).optional(),
  topic: z.string().trim().min(2).max(120),
  preferredCallback: z.string().trim().max(120).optional(),
  message: z.string().trim().min(5, 'Please describe your enquiry').max(4000),
  consentAccepted: z.literal(true),
  website: z.string().optional(),
});

async function staffToNotify(pool) {
  const [admins] = await pool
    .execute(
      `SELECT id, role FROM user_profiles
       WHERE role IN ('admin', 'super_admin') AND COALESCE(is_active, TRUE) = TRUE
       LIMIT 25`,
    )
    .catch(() => [[]]);
  const [employees] = await pool
    .execute(
      `SELECT id, role FROM user_profiles
       WHERE role = 'employee' AND COALESCE(is_active, TRUE) = TRUE
       LIMIT 100`,
    )
    .catch(() => [[]]);

  let accessMap = {};
  try {
    accessMap = await fetchEmployeeAccessControlsMap((employees || []).map((e) => e.id));
  } catch {
    accessMap = {};
  }
  const leadEmployees = (employees || []).filter((e) => {
    const access = buildEffectiveEmployeeAccess(accessMap[e.id] || []);
    return employeeHasModulePermission(access, 'leads', 'read');
  });
  return [...(admins || []), ...leadEmployees];
}

async function notifyStaffInApp(pool, { inquiryId, fullName, phone, topic }) {
  let notified = 0;
  try {
    const { createStaffNotification } = await import('./notifications.js');
    const staff = await staffToNotify(pool);
    for (const s of staff) {
      try {
        await createStaffNotification(pool, {
          userId: s.id,
          role: s.role,
          eventType: 'website_enquiry',
          title: `New website enquiry — ${fullName}`,
          message: `${topic} · +91-${phone}\nOpen Website Enquiries to respond.`,
          data: { inquiryId },
        });
        notified += 1;
      } catch (err) {
        console.warn('[enquiry:in-app]', err?.message || err);
      }
    }
  } catch (err) {
    console.warn('[enquiry:in-app:setup]', err?.message || err);
  }
  return notified;
}

publicEnquiriesRouter.get('/topics', (_req, res) => {
  res.json({ topics: TOPICS });
});

publicEnquiriesRouter.post('/', async (req, res, next) => {
  try {
    const input = PublicEnquirySchema.parse(req.body || {});

    // Honeypot: bots fill hidden fields. Pretend success, store nothing.
    if (input.website && input.website.trim()) {
      return res.status(201).json({ success: true, message: 'Thank you. Our team will contact you shortly.' });
    }

    const ip = getClientIp(req) || 'unknown';
    if (hitRateLimit(`ip:${ip}`, MAX_PER_IP) || hitRateLimit(`phone:${input.phone}`, MAX_PER_PHONE)) {
      return res.status(429).json({
        error: 'We have already received your enquiry. Our team will contact you soon.',
      });
    }

    await ensureEnquirySchema();
    const pool = getPool();
    const inquiryId = newId();
    await pool.execute(
      `INSERT INTO contact_inquiries
         (id, full_name, email, phone, subject, message, consent_accepted, status,
          source, city, preferred_callback, submitter_ip)
       VALUES
         (:id, :full_name, :email, :phone, :subject, :message, TRUE, 'new',
          'website_enquiry', :city, :preferred_callback, :ip)`,
      {
        id: inquiryId,
        full_name: input.fullName,
        email: input.email || null,
        phone: input.phone,
        subject: input.topic,
        message: input.message,
        city: input.city || null,
        preferred_callback: input.preferredCallback || null,
        ip,
      },
    );

    const reference = inquiryId.slice(0, 8).toUpperCase();

    // Notifications are best-effort; the enquiry is already saved for the panels.
    const notify = async () => {
      const contact = await getSiteContactSettings().catch(() => null);
      const inboxes = supportInboxes(contact);
      const lines = [
        'New website enquiry',
        '',
        `Name: ${input.fullName}`,
        `Mobile: +91-${input.phone}`,
        input.email ? `Email: ${input.email}` : null,
        input.city ? `City: ${input.city}` : null,
        `Topic: ${input.topic}`,
        input.preferredCallback ? `Preferred callback: ${input.preferredCallback}` : null,
        '',
        'Message:',
        input.message,
        '',
        `Reference: ${reference}`,
        'Manage it in Admin / Employee panel → Website Enquiries.',
      ].filter((l) => l !== null);
      await sendEmail({
        to: inboxes,
        subject: `[Enquiry] ${input.topic} — ${input.fullName}`,
        text: lines.join('\n'),
        replyTo: input.email || undefined,
        recipientName: 'Rfincare Support',
      }).catch((err) => console.warn('[enquiry:support-mail]', err?.message || err));

      if (input.email) {
        await sendEmail({
          to: input.email,
          subject: 'We received your enquiry — Rfincare',
          text: [
            `Hi ${input.fullName},`,
            '',
            'Thank you for contacting Rfincare. Our team has received your enquiry and will call you shortly.',
            '',
            `Topic: ${input.topic}`,
            `Reference: ${reference}`,
            '',
            '— Rfincare Support',
          ].join('\n'),
          recipientName: input.fullName,
          replyTo: inboxes[0],
        }).catch((err) => console.warn('[enquiry:customer-mail]', err?.message || err));
      }

      await notifyStaffInApp(pool, {
        inquiryId,
        fullName: input.fullName,
        phone: input.phone,
        topic: input.topic,
      });
    };
    notify().catch((err) => console.warn('[enquiry:notify]', err?.message || err));

    res.status(201).json({
      success: true,
      reference,
      message: 'Thank you. Our team will contact you shortly.',
    });
  } catch (err) {
    next(err);
  }
});

/* ---------- Staff inbox ---------- */

function isAdmin(role) {
  return role === 'admin' || role === 'super_admin';
}

function requireEnquiryAccess(permission) {
  return async (req, _res, next) => {
    try {
      if (isAdmin(req.auth?.role)) return next();
      if (req.auth?.role === 'employee') {
        await assertEmployeeAccess(req, 'leads', permission);
        return next();
      }
      const e = new Error('Insufficient permissions');
      e.status = 403;
      throw e;
    } catch (err) {
      next(err);
    }
  };
}

function mapEnquiry(row) {
  return {
    id: row.id,
    reference: String(row.id || '').slice(0, 8).toUpperCase(),
    fullName: row.full_name,
    email: row.email || null,
    phone: row.phone,
    city: row.city || null,
    topic: row.subject,
    message: row.message,
    preferredCallback: row.preferred_callback || null,
    source: row.source || 'contact_us',
    status: row.status || 'new',
    staffRemarks: row.staff_remarks || null,
    handledBy: row.handled_by || null,
    handledByName: row.handled_by_name || null,
    handledAt: row.handled_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAction(row) {
  return {
    id: row.id,
    actorName: row.actor_name || null,
    actorRole: row.actor_role || null,
    statusFrom: row.status_from || null,
    statusTo: row.status_to || null,
    remarks: row.remarks || null,
    createdAt: row.created_at,
  };
}

staffEnquiriesRouter.use(authenticate);

staffEnquiriesRouter.get('/', requireEnquiryAccess('read'), async (req, res, next) => {
  try {
    await ensureEnquirySchema();
    const pool = getPool();
    const status = ENQUIRY_STATUSES.includes(String(req.query.status || '')) ? String(req.query.status) : '';
    const source = ['website_enquiry', 'contact_us'].includes(String(req.query.source || ''))
      ? String(req.query.source)
      : '';
    const q = String(req.query.q || '').trim().slice(0, 100);
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const [rows] = await pool.execute(
      `SELECT * FROM contact_inquiries
       WHERE (:status = '' OR status = :status)
         AND (:source = '' OR COALESCE(source, 'contact_us') = :source)
         AND (:q = '' OR full_name ILIKE :like OR phone ILIKE :like
              OR COALESCE(email, '') ILIKE :like OR subject ILIKE :like)
       ORDER BY created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      { status, source, q, like: `%${q}%` },
    );
    const [countRows] = await pool.execute(
      `SELECT status, COUNT(*)::int AS cnt FROM contact_inquiries GROUP BY status`,
    );
    const counts = Object.fromEntries(ENQUIRY_STATUSES.map((s) => [s, 0]));
    for (const r of countRows || []) counts[r.status || 'new'] = Number(r.cnt || 0);

    res.json({ enquiries: (rows || []).map(mapEnquiry), counts, statuses: ENQUIRY_STATUSES });
  } catch (err) {
    next(err);
  }
});

staffEnquiriesRouter.get('/:id', requireEnquiryAccess('read'), async (req, res, next) => {
  try {
    await ensureEnquirySchema();
    const pool = getPool();
    const [[row]] = await pool.execute(`SELECT * FROM contact_inquiries WHERE id = :id LIMIT 1`, {
      id: req.params.id,
    });
    if (!row) return res.status(404).json({ error: 'Enquiry not found' });
    const [actions] = await pool.execute(
      `SELECT * FROM contact_inquiry_actions WHERE inquiry_id = :id ORDER BY created_at DESC`,
      { id: row.id },
    );
    res.json({ enquiry: mapEnquiry(row), actions: (actions || []).map(mapAction) });
  } catch (err) {
    next(err);
  }
});

const UpdateSchema = z.object({
  status: z.enum(ENQUIRY_STATUSES).optional(),
  remarks: z.string().trim().max(2000).optional(),
});

staffEnquiriesRouter.patch('/:id', requireEnquiryAccess('write'), async (req, res, next) => {
  try {
    await ensureEnquirySchema();
    const input = UpdateSchema.parse(req.body || {});
    if (!input.status && !input.remarks) {
      return res.status(400).json({ error: 'Provide a status or remarks' });
    }
    const pool = getPool();
    const [[row]] = await pool.execute(`SELECT * FROM contact_inquiries WHERE id = :id LIMIT 1`, {
      id: req.params.id,
    });
    if (!row) return res.status(404).json({ error: 'Enquiry not found' });

    const [[actor]] = await pool.execute(
      `SELECT full_name, email FROM user_profiles WHERE id = :id LIMIT 1`,
      { id: req.auth.userId },
    );
    const actorName = actor?.full_name || actor?.email || req.auth.email || 'Staff';
    const nextStatus = input.status || row.status || 'new';

    await pool.execute(
      `UPDATE contact_inquiries SET
         status = :status,
         staff_remarks = COALESCE(:remarks, staff_remarks),
         handled_by = :uid,
         handled_by_name = :name,
         handled_at = NOW(),
         updated_at = NOW()
       WHERE id = :id`,
      {
        id: row.id,
        status: nextStatus,
        remarks: input.remarks || null,
        uid: req.auth.userId,
        name: actorName,
      },
    );
    await pool.execute(
      `INSERT INTO contact_inquiry_actions
         (id, inquiry_id, actor_user_id, actor_name, actor_role, status_from, status_to, remarks)
       VALUES (:id, :inquiry_id, :uid, :name, :role, :from, :to, :remarks)`,
      {
        id: newId(),
        inquiry_id: row.id,
        uid: req.auth.userId,
        name: actorName,
        role: req.auth.role,
        from: row.status || 'new',
        to: nextStatus,
        remarks: input.remarks || null,
      },
    );

    const [[updated]] = await pool.execute(`SELECT * FROM contact_inquiries WHERE id = :id LIMIT 1`, {
      id: row.id,
    });
    const [actions] = await pool.execute(
      `SELECT * FROM contact_inquiry_actions WHERE inquiry_id = :id ORDER BY created_at DESC`,
      { id: row.id },
    );
    res.json({ enquiry: mapEnquiry(updated), actions: (actions || []).map(mapAction) });
  } catch (err) {
    next(err);
  }
});
