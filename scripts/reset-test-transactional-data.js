/**
 * Wipe transactional / UAT test data so flows can be retested from a clean slate.
 *
 * KEEPS: banks, products, staff (admin/agent/employee), CMS, policy matrices,
 *        referral rules/settings, lead TAT settings (duration etc.).
 *
 * REMOVES: marketing leads + TAT/assignment history, loan applications,
 *          drafts, eligibility/CIBIL checks, pending registrations,
 *          referral clicks/attributions/transactions, marketplace orders,
 *          appointments, staff/customer notifications related to ops noise.
 *
 * Usage (from backend/):
 *   CONFIRM=YES node scripts/reset-test-transactional-data.js
 *
 * Optional:
 *   INCLUDE_CUSTOMERS=YES  — also delete customer accounts except demo emails
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { getPool } from '../src/db/pool.js';
import { hardDeleteApplications } from '../src/lib/hardDeleteApplications.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

const DEMO_CUSTOMER_EMAILS = new Set([
  'customer@rfincare.com',
  'admin@rfincare.com',
  'employee@rfincare.com',
  'agent@rfincare.com',
]);

async function runDelete(pool, label, sql, params = {}) {
  try {
    const [result] = await pool.execute(sql, params);
    const n = result?.affectedRows ?? result?.rowCount ?? 0;
    console.log(`  ✓ ${label}: ${n}`);
    return Number(n) || 0;
  } catch (err) {
    if (err?.code === '42P01' || err?.code === '42703') {
      console.log(`  · ${label}: skipped (table/column missing)`);
      return 0;
    }
    console.error(`  ✗ ${label}:`, err.message || err);
    throw err;
  }
}

async function main() {
  if (String(process.env.CONFIRM || '').toUpperCase() !== 'YES') {
    console.error(
      'Refusing to run without CONFIRM=YES\n'
      + 'Example: CONFIRM=YES node scripts/reset-test-transactional-data.js',
    );
    process.exit(1);
  }

  const includeCustomers = String(process.env.INCLUDE_CUSTOMERS || '').toUpperCase() === 'YES';
  const pool = getPool();

  console.log('\nResetting transactional test data…');
  console.log(`INCLUDE_CUSTOMERS=${includeCustomers ? 'YES' : 'NO'}\n`);

  // --- Lead engine ---
  await runDelete(pool, 'lead_activities', `DELETE FROM lead_activities`);
  await runDelete(pool, 'lead_assignment_history', `DELETE FROM lead_assignment_history`);
  await runDelete(pool, 'lead_otps', `DELETE FROM lead_otps`);
  await runDelete(pool, 'marketing_leads', `DELETE FROM marketing_leads`);
  await runDelete(
    pool,
    'lead_assignment_settings (queue pointer)',
    `UPDATE lead_assignment_settings SET
       last_assigned_employee_id = NULL,
       updated_at = NOW()
     WHERE id = 'default'`,
  );
  await runDelete(
    pool,
    'employee missed_lead_count reset',
    `UPDATE employee_onboarding SET missed_lead_count = 0 WHERE missed_lead_count IS DISTINCT FROM 0`,
  );

  // --- Applications ---
  try {
    const [apps] = await pool.execute(`SELECT id FROM loan_applications`);
    const ids = (apps || []).map((r) => r.id).filter(Boolean);
    if (ids.length) {
      const { deleted } = await hardDeleteApplications(pool, ids);
      console.log(`  ✓ loan_applications (hard delete): ${deleted}`);
    } else {
      console.log('  ✓ loan_applications (hard delete): 0');
    }
  } catch (err) {
    if (err?.code === '42P01') console.log('  · loan_applications: skipped');
    else throw err;
  }

  await runDelete(pool, 'application_form_drafts', `DELETE FROM application_form_drafts`);
  await runDelete(pool, 'resume_tokens (if any)', `DELETE FROM resume_tokens`);
  await runDelete(pool, 'application_resume_tokens (if any)', `DELETE FROM application_resume_tokens`);

  // --- Assessments / CIBIL ---
  await runDelete(pool, 'eligibility_assessments', `DELETE FROM eligibility_assessments`);
  await runDelete(pool, 'cibil_checks', `DELETE FROM cibil_checks`);
  await runDelete(pool, 'status_check_otps', `DELETE FROM status_check_otps`);

  // --- Registrations / appointments ---
  await runDelete(pool, 'customer_registrations', `DELETE FROM customer_registrations`);
  await runDelete(pool, 'partner_registrations', `DELETE FROM partner_registrations`);
  await runDelete(pool, 'expert_appointments', `DELETE FROM expert_appointments`);

  // --- Referral runtime (keep rules/settings) ---
  await runDelete(pool, 'referral_transactions', `DELETE FROM referral_transactions`);
  await runDelete(pool, 'referral_attributions', `DELETE FROM referral_attributions`);
  await runDelete(pool, 'referral_clicks', `DELETE FROM referral_clicks`);
  await runDelete(pool, 'referral_invites', `DELETE FROM referral_invites`);

  // --- Marketplace purchases / SIPs ---
  await runDelete(pool, 'insurance_purchase_events', `DELETE FROM insurance_purchase_events`);
  await runDelete(pool, 'insurance_purchase_orders', `DELETE FROM insurance_purchase_orders`);
  await runDelete(pool, 'mutual_fund_sip_orders', `DELETE FROM mutual_fund_sip_orders`);

  // --- Notifications / noise ---
  await runDelete(pool, 'staff_notifications', `DELETE FROM staff_notifications`);
  await runDelete(pool, 'customer_notifications', `DELETE FROM customer_notifications`);
  await runDelete(pool, 'customer_support_messages', `DELETE FROM customer_support_messages`);
  await runDelete(pool, 'marketing_events', `DELETE FROM marketing_events`);

  if (includeCustomers) {
    console.log('\nRemoving non-demo customer accounts…');
    const [customers] = await pool.execute(
      `SELECT id, email FROM user_profiles WHERE role = 'customer'`,
    );
    for (const row of customers || []) {
      const email = String(row.email || '').toLowerCase();
      if (DEMO_CUSTOMER_EMAILS.has(email)) {
        console.log(`  · keep demo customer: ${email}`);
        continue;
      }
      try {
        // Best-effort cascade for non-demo customers
        await runDelete(pool, `auth refresh tokens ${email}`, `DELETE FROM refresh_tokens WHERE user_id = :id`, {
          id: row.id,
        });
        await runDelete(pool, `push tokens ${email}`, `DELETE FROM push_device_tokens WHERE user_id = :id`, {
          id: row.id,
        });
        await runDelete(pool, `oauth links ${email}`, `DELETE FROM oauth_accounts WHERE user_id = :id`, {
          id: row.id,
        });
        await pool.execute(`DELETE FROM user_profiles WHERE id = :id`, { id: row.id });
        await pool.execute(`DELETE FROM auth_users WHERE id = :id`, { id: row.id });
        console.log(`  ✓ deleted customer: ${email || row.id}`);
      } catch (err) {
        console.warn(`  ! could not fully delete ${email}:`, err.message || err);
      }
    }
  }

  console.log('\nDone. Staff logins, banks/products, and TAT settings were preserved.');
  console.log('You can retest lead capture / assignment / TAT from a clean queue.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('\nReset failed:', err);
  process.exit(1);
});
