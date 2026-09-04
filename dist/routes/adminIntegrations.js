import { Router } from "express";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { getPool } from "../db/pool.js";
import { newId } from "../lib/ids.js";
import { writeAuditLog } from "../lib/audit.js";
import { sendEmail } from "../lib/email.js";
import { resolveUploadFilePath } from "../lib/uploadPaths.js";
import {
  getPaymentGatewaySettingsPublic,
  savePaymentGatewaySettings
} from "../lib/paymentGatewaySettings.js";
const adminIntegrationsRouter = Router();
adminIntegrationsRouter.get(
  "/payment-gateway",
  authenticate,
  authorize({ resource: "banks", action: "read" }),
  async (_req, res, next) => {
    try {
      res.json(await getPaymentGatewaySettingsPublic());
    } catch (err) {
      next(err);
    }
  }
);
adminIntegrationsRouter.put(
  "/payment-gateway",
  authenticate,
  authorize({ resource: "banks", action: "manage" }),
  async (req, res, next) => {
    try {
      const saved = await savePaymentGatewaySettings(req.body || {}, req.auth.userId);
      await writeAuditLog({
        userId: req.auth.userId,
        actionType: "update",
        tableName: "payment_gateway_settings",
        recordId: "default",
        newValues: { scope: "payment_gateway_settings", mode: saved.mode, isEnabled: saved.isEnabled }
      });
      res.json(saved);
    } catch (err) {
      next(err);
    }
  }
);
const ShareSchema = z.object({
  employeeEmail: z.string().email(),
  employeeName: z.string().optional(),
  bankId: z.string().optional(),
  bankName: z.string().optional(),
  locationLabel: z.string().optional(),
  branchLabel: z.string().optional(),
  ccEmails: z.array(z.string().email()).optional(),
  includeCcHierarchy: z.boolean().optional(),
  message: z.string().optional()
});
async function ensureShareLogTable(pool) {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS application_bank_share_log (
      id CHAR(36) NOT NULL,
      application_id CHAR(36) NOT NULL,
      bank_id CHAR(36) NULL,
      bank_name VARCHAR(255) NULL,
      location_label VARCHAR(255) NULL,
      branch_label VARCHAR(255) NULL,
      employee_name VARCHAR(255) NULL,
      employee_email VARCHAR(320) NOT NULL,
      cc_emails TEXT NULL,
      shared_by CHAR(36) NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'sent',
      detail_json JSON NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    )
  `);
}
async function resolveHierarchyCcEmails(pool, application) {
  const emails = [];
  if (!application?.agent_id) return emails;
  try {
    const [rows] = await pool.execute(
      `SELECT em.email
       FROM agent_employee_hierarchy h
       JOIN user_profiles em ON em.id = h.employee_user_id
       WHERE h.agent_user_id = :agentId
         AND em.email IS NOT NULL
         AND TRIM(em.email) <> ''
       ORDER BY h.hierarchy_level ASC
       LIMIT 10`,
      { agentId: application.agent_id }
    );
    for (const row of rows || []) {
      if (row.email) emails.push(String(row.email).trim().toLowerCase());
    }
  } catch {
  }
  return [...new Set(emails)];
}
adminIntegrationsRouter.post(
  "/applications/:id/share-to-bank",
  authenticate,
  authorize({ resource: "loan_applications", action: "update" }),
  async (req, res, next) => {
    try {
      const input = ShareSchema.parse(req.body || {});
      const pool = getPool();
      await ensureShareLogTable(pool);
      const [[app]] = await pool.execute(
        `SELECT la.*, up.full_name AS customer_name, up.email AS customer_email
         FROM loan_applications la
         LEFT JOIN user_profiles up ON up.id = la.customer_id
         WHERE la.id = :id LIMIT 1`,
        { id: req.params.id }
      );
      if (!app) {
        return res.status(404).json({ error: "Application not found" });
      }
      let bankName = input.bankName || "";
      if (input.bankId) {
        const [[bank]] = await pool.execute(`SELECT name FROM banks WHERE id = :id LIMIT 1`, {
          id: input.bankId
        });
        bankName = bank?.name || bankName;
      }
      const data = typeof app.data === "string" ? (() => {
        try {
          return JSON.parse(app.data);
        } catch {
          return {};
        }
      })() : app.data || {};
      const attachments = [];
      const packagePath = data.application_package_pdf;
      if (packagePath) {
        try {
          const rel = String(packagePath).replace(/^\/uploads\//, "");
          const full = resolveUploadFilePath(rel);
          const content = await readFile(full);
          attachments.push({
            filename: `${app.application_number || app.id.slice(0, 8)}-application-pack.pdf`,
            content
          });
        } catch {
        }
      }
      const ccSet = new Set(
        (input.ccEmails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean)
      );
      if (input.includeCcHierarchy !== false) {
        for (const e of await resolveHierarchyCcEmails(pool, app)) ccSet.add(e);
      }
      const ccList = [...ccSet].filter((e) => e !== input.employeeEmail.toLowerCase());
      const subject = `Rfincare loan application pack — ${app.application_number || app.id.slice(0, 8)}`;
      const text = [
        `Hello ${input.employeeName || "Bank team"},`,
        "",
        `Please find the customer application package for review.`,
        "",
        `Application: ${app.application_number || app.id}`,
        `Customer: ${app.customer_name || "—"}`,
        `Bank: ${bankName || "—"}`,
        input.locationLabel ? `Location: ${input.locationLabel}` : null,
        input.branchLabel ? `Branch: ${input.branchLabel}` : null,
        "",
        input.message || "Shared securely from Rfincare Super Admin.",
        "",
        "— Rfincare"
      ].filter((line) => line !== null).join("\n");
      const mailResult = await sendEmail({
        to: input.employeeEmail,
        subject,
        text,
        attachments,
        cc: ccList.length ? ccList.join(",") : void 0
      });
      const logId = newId();
      await pool.execute(
        `INSERT INTO application_bank_share_log (
           id, application_id, bank_id, bank_name, location_label, branch_label,
           employee_name, employee_email, cc_emails, shared_by, status, detail_json
         ) VALUES (
           :id, :application_id, :bank_id, :bank_name, :location_label, :branch_label,
           :employee_name, :employee_email, :cc_emails, :shared_by, :status, :detail_json
         )`,
        {
          id: logId,
          application_id: app.id,
          bank_id: input.bankId || null,
          bank_name: bankName || null,
          location_label: input.locationLabel || null,
          branch_label: input.branchLabel || null,
          employee_name: input.employeeName || null,
          employee_email: input.employeeEmail,
          cc_emails: ccList.join(",") || null,
          shared_by: req.auth.userId,
          status: mailResult?.sent ? "sent" : "queued_or_logged",
          detail_json: JSON.stringify({
            mailResult,
            attachmentCount: attachments.length
          })
        }
      );
      await writeAuditLog({
        userId: req.auth.userId,
        actionType: "update",
        tableName: "loan_applications",
        recordId: app.id,
        newValues: {
          scope: "share_to_bank_employee",
          employeeEmail: input.employeeEmail,
          bankName
        }
      });
      res.json({
        success: true,
        shareId: logId,
        sent: Boolean(mailResult?.sent),
        attachmentCount: attachments.length,
        ccCount: ccList.length,
        warning: mailResult?.warning || null
      });
    } catch (err) {
      next(err);
    }
  }
);
export {
  adminIntegrationsRouter
};
