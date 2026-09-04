import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { authenticate } from "../middleware/authenticate.js";
import { getPool } from "../db/pool.js";
import { ensureMilestone4Schema } from "../db/ensureMilestone4Schema.js";
import { ensureStaffMessagingSchema } from "../db/ensureStaffMessagingSchema.js";
import { dispatchFileUpdateNotification } from "../lib/fileNotificationService.js";
import { ensureAgentCodeForUser } from "../lib/agentCode.js";
import { sendStaffWelcomeEmail } from "../lib/email.js";
import { pullCibilForEmployee } from "../lib/cibilService.js";
import { sqlCastParam, sqlCoalescePatch } from "../lib/sqlCollation.js";
import {
  assertEmployeeAccess,
  getEffectiveEmployeeAccess,
  requireEmployeeModuleAccess
} from "../lib/employeeAccessControls.js";
import { autoAssignPendingAgentsToEmployees } from "../lib/employeeApplicationAssignment.js";
const portalEmployeeMilestone4Router = Router();
function requireEmployee(req) {
  if (!["employee", "admin", "super_admin"].includes(req.auth.role)) {
    const e = new Error("Employee access only");
    e.status = 403;
    throw e;
  }
}
portalEmployeeMilestone4Router.use(authenticate);
portalEmployeeMilestone4Router.get("/customers/:customerId", async (req, res, next) => {
  try {
    requireEmployee(req);
    await assertEmployeeAccess(req, "customers", "read");
    const pool = getPool();
    const [[customer]] = await pool.execute(
      `SELECT id, full_name, email, phone, avatar_url, customer_code, created_at
       FROM user_profiles WHERE id = :id AND role = 'customer' LIMIT 1`,
      { id: req.params.customerId }
    );
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    const [applications] = await pool.execute(
      `SELECT id, application_number, status, journey_mode, submitted_at, created_at
       FROM loan_applications WHERE customer_id = :id ORDER BY created_at DESC`,
      { id: req.params.customerId }
    );
    res.json({
      customer: {
        id: customer.id,
        fullName: customer.full_name,
        email: customer.email,
        phone: customer.phone,
        customerCode: customer.customer_code,
        createdAt: customer.created_at
      },
      applications
    });
  } catch (err) {
    next(err);
  }
});
portalEmployeeMilestone4Router.get("/agent-onboarding/pending", async (req, res, next) => {
  try {
    requireEmployee(req);
    if (req.auth.role === "employee") {
      const access = await getEffectiveEmployeeAccess(req.auth.userId);
      requireEmployeeModuleAccess(access, "agents", "read");
    }
    await ensureMilestone4Schema();
    await ensureStaffMessagingSchema();
    const pool = getPool();
    await autoAssignPendingAgentsToEmployees(pool);
    const isEmployee = req.auth.role === "employee";
    const employeeJoin = isEmployee ? `JOIN agent_employee_hierarchy aeh
         ON aeh.agent_user_id = ao.user_id
        AND aeh.employee_user_id = :employee_id` : "";
    const employeeWhere = isEmployee ? "AND aeh.employee_user_id = :employee_id" : "";
    const [rows] = await pool.execute(
      `SELECT ao.*, up.full_name, up.email, up.phone
       FROM agent_onboarding ao
       JOIN user_profiles up ON up.id = ao.user_id
       ${employeeJoin}
       WHERE CAST(ao.qc_status AS TEXT)
         IN ('pending_qc', 'qc_review')
         ${employeeWhere}
       ORDER BY ao.created_at ASC`,
      isEmployee ? { employee_id: req.auth.userId } : {}
    );
    res.json(
      rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        agentName: r.agent_name,
        agentCode: r.agent_code,
        username: r.username,
        email: r.email,
        mobileNumber: r.mobile_number,
        bankName: r.bank_name,
        accountNumber: r.account_number,
        ifscCode: r.ifsc_code,
        qcStatus: r.qc_status,
        onboardingStatus: r.onboarding_status,
        createdAt: r.created_at
      }))
    );
  } catch (err) {
    next(err);
  }
});
const QcDecisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  notes: z.string().optional(),
  temporaryPassword: z.string().min(8).optional(),
  password: z.string().min(8).optional()
});
portalEmployeeMilestone4Router.post("/agent-onboarding/:userId/qc", async (req, res, next) => {
  try {
    requireEmployee(req);
    await ensureMilestone4Schema();
    await ensureStaffMessagingSchema();
    const pool = getPool();
    const input = QcDecisionSchema.parse(req.body);
    const tempPassword = input.temporaryPassword || input.password || null;
    if (req.auth.role === "employee") {
      const access = await getEffectiveEmployeeAccess(req.auth.userId);
      requireEmployeeModuleAccess(
        access,
        "agents",
        input.decision === "approved" ? "approve" : "reject"
      );
      const [[mapping]] = await pool.execute(
        `SELECT id
         FROM agent_employee_hierarchy
         WHERE agent_user_id = :agent_id AND employee_user_id = :employee_id
         LIMIT 1`,
        { agent_id: req.params.userId, employee_id: req.auth.userId }
      );
      if (!mapping?.id) {
        return res.status(403).json({
          error: "This agent is not assigned to you for verification. Please refresh your queue."
        });
      }
    }
    const [[agent]] = await pool.execute(
      `SELECT * FROM agent_onboarding WHERE user_id = :id LIMIT 1`,
      { id: req.params.userId }
    );
    if (!agent) return res.status(404).json({ error: "Agent onboarding not found" });
    if (input.decision === "approved") {
      if (tempPassword) {
        const passwordHash = await bcrypt.hash(tempPassword, 12);
        await pool.execute(`UPDATE auth_users SET password_hash = :ph WHERE id = :id`, {
          ph: passwordHash,
          id: req.params.userId
        });
        await pool.execute(
          `UPDATE user_profiles SET password_change_required = 0 WHERE id = :id`,
          { id: req.params.userId }
        );
      }
      await ensureAgentCodeForUser(pool, req.params.userId);
      await pool.execute(
        `UPDATE agent_onboarding
         SET qc_status = ${sqlCastParam("qc_status")},
             qc_employee_id = :emp,
             qc_notes = ${sqlCoalescePatch("qc_notes", "notes")},
             qc_at = NOW(),
             qc_approved_by = :emp,
             onboarding_status = ${sqlCastParam("onboarding_status")}
         WHERE user_id = :id`,
        {
          id: req.params.userId,
          emp: req.auth.userId,
          notes: input.notes || null,
          qc_status: "qc_approved",
          onboarding_status: "active"
        }
      );
      await pool.execute(
        `UPDATE user_profiles SET
           is_active = TRUE,
           account_status = ${sqlCastParam("account_status")},
           onboarding_status = ${sqlCastParam("profile_onboarding_status")}
         WHERE id = :id`,
        {
          id: req.params.userId,
          account_status: "active",
          profile_onboarding_status: "active"
        }
      );
      if (tempPassword) {
        await sendStaffWelcomeEmail({
          email: agent.email,
          fullName: agent.agent_name,
          role: "agent",
          password: tempPassword,
          loginPath: "/agent-login"
        }).catch((err) => console.warn("[agent-qc-email]", err.message));
      }
    } else {
      await pool.execute(
        `UPDATE agent_onboarding
         SET qc_status = ${sqlCastParam("qc_status")},
             qc_employee_id = :emp,
             qc_notes = ${sqlCastParam("notes")},
             qc_at = NOW(),
             onboarding_status = ${sqlCastParam("onboarding_status")}
         WHERE user_id = :id`,
        {
          id: req.params.userId,
          emp: req.auth.userId,
          notes: input.notes || "QC rejected",
          qc_status: "qc_rejected",
          onboarding_status: "rejected"
        }
      );
      await pool.execute(
        `UPDATE user_profiles SET
           is_active = FALSE,
           account_status = ${sqlCastParam("account_status")},
           onboarding_status = ${sqlCastParam("profile_onboarding_status")}
         WHERE id = :id`,
        {
          id: req.params.userId,
          account_status: "suspended",
          profile_onboarding_status: "rejected"
        }
      );
    }
    res.json({ success: true, decision: input.decision });
  } catch (err) {
    next(err);
  }
});
const EmployeeCibilPullSchema = z.object({
  fullName: z.string().min(2, "Name is required"),
  fatherName: z.string().min(2, "Father's name is required"),
  panNumber: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/i, "Enter a valid PAN number"),
  mobile: z.string().min(10, "Mobile number is required"),
  pincode: z.string().regex(/^\d{6}$/, "Enter a valid 6-digit pincode"),
  consentAccepted: z.literal(true, { errorMap: () => ({ message: "Consent is required" }) })
});
portalEmployeeMilestone4Router.post("/cibil/pull", async (req, res, next) => {
  try {
    requireEmployee(req);
    if (req.auth.role === "employee") {
      await assertEmployeeAccess(req, "applications", "read");
    }
    const input = EmployeeCibilPullSchema.parse(req.body);
    const phone = String(input.mobile).replace(/\D/g, "").slice(-10);
    const result = await pullCibilForEmployee(
      {
        fullName: input.fullName.trim(),
        fatherName: input.fatherName.trim(),
        panNumber: input.panNumber.toUpperCase(),
        mobile: phone,
        pincode: input.pincode,
        consentAccepted: true
      },
      req.auth.userId
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});
portalEmployeeMilestone4Router.get("/notifications", async (req, res, next) => {
  try {
    requireEmployee(req);
    await ensureMilestone4Schema();
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT id, application_id, event_type, title, message, is_read, created_at
       FROM staff_notifications WHERE user_id = :uid ORDER BY created_at DESC LIMIT 50`,
      { uid: req.auth.userId }
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});
function mapEmployeeManagedAgent(row) {
  return {
    id: row.id,
    agentName: row.agent_name || row.full_name,
    agentCode: row.agent_code || null,
    username: row.username || null,
    email: row.email,
    mobileNumber: row.mobile_number || row.phone,
    accountStatus: row.account_status,
    onboardingStatus: row.ao_status || row.onboarding_status,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    totalApplications: Number(row.total_applications || 0)
  };
}
portalEmployeeMilestone4Router.get("/agents", async (req, res, next) => {
  try {
    requireEmployee(req);
    await assertEmployeeAccess(req, "agents", "read");
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT up.*,
              ao.agent_code,
              ao.username,
              ao.agent_name,
              ao.mobile_number,
              ao.onboarding_status AS ao_status,
              (SELECT COUNT(*) FROM loan_applications la WHERE la.agent_id = up.id) AS total_applications
       FROM user_profiles up
       LEFT JOIN agent_onboarding ao ON ao.user_id = up.id
       WHERE up.role = 'agent'
       ORDER BY up.created_at DESC
       LIMIT 500`
    );
    res.json(rows.map(mapEmployeeManagedAgent));
  } catch (err) {
    next(err);
  }
});
portalEmployeeMilestone4Router.post("/agents", async (req, res, next) => {
  try {
    requireEmployee(req);
    await assertEmployeeAccess(req, "agents", "write");
    const { createAgentAccount } = await import("../lib/staffOnboarding.js");
    const row = await createAgentAccount(req.body, req.auth.userId);
    res.status(201).json(
      mapEmployeeManagedAgent({
        ...row,
        agent_name: row.full_name || row.agent_name,
        agent_code: row.agent_code,
        ao_status: row.ao_status || row.onboarding_status,
        total_applications: 0
      })
    );
  } catch (err) {
    next(err);
  }
});
const AgentStatusSchema = z.object({
  accountStatus: z.enum(["active", "inactive", "suspended", "pending"])
});
portalEmployeeMilestone4Router.patch("/agents/:id/status", async (req, res, next) => {
  try {
    requireEmployee(req);
    await assertEmployeeAccess(req, "agents", "write");
    const input = AgentStatusSchema.parse({
      accountStatus: req.body?.accountStatus ?? req.body?.account_status
    });
    const { updateAgentDetails, fetchAgentDetail } = await import("../lib/adminStaffManage.js");
    const detail = await updateAgentDetails(req.params.id, {
      accountStatus: input.accountStatus,
      onboardingStatus: input.accountStatus === "active" ? "active" : input.accountStatus
    });
    res.json(detail || await fetchAgentDetail(req.params.id));
  } catch (err) {
    next(err);
  }
});
portalEmployeeMilestone4Router.get("/agents/:id/reports", async (req, res, next) => {
  try {
    requireEmployee(req);
    await assertEmployeeAccess(req, "agents", "read");
    const {
      buildAgentCommissionReport,
      commissionReportToCsv,
      commissionReportToPdf
    } = await import("../lib/commissionReportService.js");
    const report = await buildAgentCommissionReport(req.params.id, {
      from: req.query.from || null,
      to: req.query.to || null,
      applicationStatus: req.query.applicationStatus || "all",
      commissionStatus: req.query.commissionStatus || "all",
      loanType: req.query.loanType || "all"
    });
    const format = String(req.query.format || "json").toLowerCase();
    if (format === "xlsx" || format === "excel") {
      const { commissionReportToXlsx } = await import("../lib/commissionReportService.js");
      const buf = commissionReportToXlsx(report);
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="agent-report-${req.params.id.slice(0, 8)}-${Date.now()}.xlsx"`
      );
      return res.send(buf);
    }
    if (format === "csv") {
      const csv = commissionReportToCsv(report);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="agent-report-${req.params.id.slice(0, 8)}-${Date.now()}.csv"`
      );
      return res.send(csv);
    }
    if (format === "pdf") {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="agent-report-${req.params.id.slice(0, 8)}-${Date.now()}.pdf"`
      );
      return res.send(commissionReportToPdf(report));
    }
    res.json(report);
  } catch (err) {
    next(err);
  }
});
export {
  portalEmployeeMilestone4Router
};
