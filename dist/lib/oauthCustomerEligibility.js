import { isDbInactive } from "../db/boolean.js";
import { getPool } from "../db/pool.js";
import { getOAuthGlobalSettings } from "./oauthProviderSettings.js";
import { sqlParamEqualsLower } from "./sqlCollation.js";
async function checkCustomerEmailForOAuth(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) {
    return { allowed: false, reason: "no_email" };
  }
  const global = await getOAuthGlobalSettings();
  if (!global.requireAppliedCustomerEmail) {
    return { allowed: true };
  }
  const pool = getPool();
  const [[profile]] = await pool.execute(
    `SELECT id, role, is_active FROM user_profiles WHERE LOWER(email) = :email LIMIT 1`,
    { email: normalized }
  );
  if (profile) {
    if (profile.role !== "customer") {
      return { allowed: false, reason: "staff_account" };
    }
    if (isDbInactive(profile.is_active)) {
      return { allowed: false, reason: "account_inactive" };
    }
    return { allowed: true, existingUserId: profile.id };
  }
  const [[lead]] = await pool.execute(
    `SELECT id FROM marketing_leads WHERE ${sqlParamEqualsLower("email", "email")} LIMIT 1`,
    { email: normalized }
  );
  if (lead) {
    return { allowed: true, source: "lead" };
  }
  const [[application]] = await pool.execute(
    `SELECT la.id FROM loan_applications la
     INNER JOIN user_profiles up ON up.id = la.customer_id
     WHERE LOWER(up.email) = :email
     LIMIT 1`,
    { email: normalized }
  );
  if (application) {
    return { allowed: true, source: "application" };
  }
  try {
    const [[pendingReg]] = await pool.execute(
      `SELECT id FROM customer_registrations
       WHERE LOWER(email) = :email AND registration_status = 'pending'
       LIMIT 1`,
      { email: normalized }
    );
    if (pendingReg) {
      return { allowed: true, source: "pending_registration" };
    }
  } catch {
  }
  return { allowed: false, reason: "not_registered" };
}
export {
  checkCustomerEmailForOAuth
};
