import { Router } from "express";
import { z } from "zod";
import { basename } from "node:path";
import {
  normalizeStoredUploadName,
  streamStoredUpload
} from "../lib/uploadPaths.js";
import { createUploadMiddleware, spreadUpload } from "../lib/multerUpload.js";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { hasPermission } from "../auth/permissions.js";
import { getPool } from "../db/pool.js";
import { ensureDocumentSchema } from "../db/ensureDocumentSchema.js";
import { ensureDocumentRequirementsSchema } from "../db/ensureDocumentRequirementsSchema.js";
import { newId } from "../lib/ids.js";
import { writeAuditLog } from "../lib/audit.js";
import { dispatchFileUpdateNotification } from "../lib/fileNotificationService.js";
import { createCustomerNotification } from "./notifications.js";
import { ensureAgentCodeForUser } from "../lib/agentCode.js";
import {
  assertEmployeeAccess,
  requireEmployeeModuleAccess,
  getEffectiveEmployeeAccess
} from "../lib/employeeAccessControls.js";
import {
  autoAssignApplicationsForEmployeeVerification,
  fetchEmployeeOwnedApplicationIds
} from "../lib/employeeApplicationAssignment.js";
const documentsRouter = Router();
const STAFF_ROLES = /* @__PURE__ */ new Set(["admin", "super_admin", "employee"]);
function isStaffRole(role) {
  return STAFF_ROLES.has(role) || hasPermission(role, "read:*");
}
function agentApplicationScopeSql(alias = "la") {
  return `(
    ${alias}.agent_id = :agent_id
    OR (
      NULLIF(TRIM(CAST(:agent_code AS TEXT)), '') IS NOT NULL
      AND (
        LOWER(TRIM(CAST(COALESCE(${alias}.sourced_agent_code, '') AS TEXT))) = LOWER(TRIM(CAST(:agent_code AS TEXT)))
        OR LOWER(TRIM(CAST(COALESCE(${alias}.data->>'sourced_agent_code', '') AS TEXT))) = LOWER(TRIM(CAST(:agent_code AS TEXT)))
        OR LOWER(TRIM(CAST(COALESCE(${alias}.data->>'sourcedAgentCode', '') AS TEXT))) = LOWER(TRIM(CAST(:agent_code AS TEXT)))
        OR LOWER(TRIM(CAST(COALESCE(${alias}.data->>'agent_code', '') AS TEXT))) = LOWER(TRIM(CAST(:agent_code AS TEXT)))
        OR LOWER(TRIM(CAST(COALESCE(${alias}.data->>'agentCode', '') AS TEXT))) = LOWER(TRIM(CAST(:agent_code AS TEXT)))
      )
    )
  )`;
}
async function resolveAgentScopeParams(pool, agentUserId) {
  const agentCode = await ensureAgentCodeForUser(pool, agentUserId) || "";
  return { agent_id: agentUserId, agent_code: agentCode };
}
async function agentCanAccessApplication(pool, agentUserId, applicationId) {
  if (!applicationId) return false;
  const scope = await resolveAgentScopeParams(pool, agentUserId);
  const [[row]] = await pool.execute(
    `SELECT id, customer_id FROM loan_applications
     WHERE id = :id AND ${agentApplicationScopeSql("loan_applications")}
     LIMIT 1`,
    { id: applicationId, ...scope }
  );
  return row || null;
}
function isAgentRole(role) {
  return role === "agent";
}
function normalizeDocStatus(row) {
  const raw = row?.verification_status || row?.status || "pending";
  const s = String(raw).toLowerCase();
  if (s === "verified") return "approved";
  if (["approved", "rejected", "pending", "uploaded", "expired"].includes(s)) return s;
  return "pending";
}
function inferMimeType(row) {
  if (row.mime_type) return row.mime_type;
  const name = String(row.document_name || basename(row.file_path) || "").toLowerCase();
  if (name.endsWith(".pdf")) return "application/pdf";
  if (/\.(jpe?g|png|gif|webp)$/.test(name)) return "image/jpeg";
  return row.mime_type || "application/octet-stream";
}
function formatDocumentRow(row) {
  const fileName = normalizeStoredUploadName(row.file_path) || basename(row.file_path || "") || row.document_name || null;
  const mimeType = inferMimeType(row);
  const isImage = mimeType.startsWith("image/");
  const isPdf = mimeType.includes("pdf");
  const previewUrl = fileName && (isImage || isPdf) ? `/uploads/${encodeURIComponent(fileName)}` : row.document_url?.startsWith("/uploads/") ? row.document_url : null;
  const verificationStatus = normalizeDocStatus(row);
  let ocrPayload = row.ocr_payload;
  if (typeof ocrPayload === "string") {
    try {
      ocrPayload = JSON.parse(ocrPayload);
    } catch {
      ocrPayload = null;
    }
  }
  return {
    ...row,
    mime_type: mimeType,
    mimeType,
    verification_status: verificationStatus,
    status: verificationStatus,
    preview_url: previewUrl,
    documentType: row.document_type,
    documentName: row.document_name,
    ocr_payload: ocrPayload,
    ocrPayload,
    ocr_status: row.ocr_status,
    ocrStatus: row.ocr_status,
    ocr_suggestion: row.ocr_suggestion,
    ocrSuggestion: row.ocr_suggestion,
    ocr_confidence: row.ocr_confidence,
    ocrConfidence: row.ocr_confidence,
    ocr_engine: row.ocr_engine,
    ocrEngine: row.ocr_engine
  };
}
function summarizeApplicationDocStatus(counts) {
  const total = Number(counts.total_docs) || 0;
  if (total === 0) return "no_documents";
  const pending = Number(counts.pending_docs) || 0;
  const rejected = Number(counts.rejected_docs) || 0;
  const approved = Number(counts.approved_docs) || 0;
  if (rejected > 0) return "has_rejected";
  if (pending > 0) return "pending_review";
  if (approved === total) return "all_approved";
  return "in_review";
}
function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
function normalizeLoanType(rawLoanType, productType) {
  const value = String(rawLoanType || "").toLowerCase();
  if (value === "secured" || value === "unsecured") return value;
  const key = `${value} ${String(productType || "").toLowerCase()}`;
  if (key.includes("home") || key.includes("mortgage") || key.includes("property") || key.includes("auto") || key.includes("car") || key.includes("gold")) {
    return "secured";
  }
  return value ? "unsecured" : null;
}
function normalizeAllowedTypes(value) {
  const list = Array.isArray(value) ? value : parseJson(value, []);
  return [...new Set((list || []).map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean))];
}
function mimeToShortType(mimeType) {
  const mt = String(mimeType || "").toLowerCase();
  if (mt.includes("pdf")) return "pdf";
  if (mt.includes("png")) return "png";
  if (mt.includes("jpg") || mt.includes("jpeg")) return "jpeg";
  if (mt.includes("webp")) return "webp";
  return mt;
}
async function resolveRequirementsForApplication(pool, applicationId) {
  await ensureDocumentRequirementsSchema();
  const [[app]] = await pool.execute(
    `SELECT selected_bank_id, data FROM loan_applications WHERE id = :id LIMIT 1`,
    { id: applicationId }
  );
  if (!app) return [];
  const data = parseJson(app.data, {});
  const bankId = app.selected_bank_id || data.preferred_bank_id || data.preferredBankId || null;
  const productType = data.loan_purpose || data.loanPurpose || data.loan_type || data.loanType || null;
  const loanType = normalizeLoanType(data.loan_type || data.loanType, productType);
  const [rows] = await pool.execute(
    `SELECT *
     FROM document_requirements
     WHERE is_active = TRUE
       AND (CAST(:bank_id AS TEXT) IS NULL OR bank_id = CAST(:bank_id AS TEXT))
       AND (
         LOWER(CAST(COALESCE(product_type, '') AS TEXT))
           = LOWER(CAST(COALESCE(:product_type, '') AS TEXT))
         OR product_type IS NULL
         OR product_type = ''
       )
       AND (
         LOWER(CAST(COALESCE(loan_type, '') AS TEXT))
           = LOWER(CAST(COALESCE(:loan_type, '') AS TEXT))
         OR loan_type IS NULL
         OR loan_type = ''
       )
     ORDER BY
       CASE WHEN bank_id IS NULL THEN 1 ELSE 0 END ASC,
       CASE WHEN product_type IS NULL OR product_type = '' THEN 1 ELSE 0 END ASC,
       CASE WHEN loan_type IS NULL OR loan_type = '' THEN 1 ELSE 0 END ASC,
       sort_order ASC,
       created_at ASC`,
    {
      bank_id: bankId || null,
      product_type: productType || null,
      loan_type: loanType || null
    }
  );
  const chosenByType = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const key = String(row.document_type || "").toLowerCase();
    if (!key || chosenByType.has(key)) continue;
    chosenByType.set(key, row);
  }
  return Array.from(chosenByType.values());
}
const documentUpload = createUploadMiddleware();
documentsRouter.get(
  "/applications",
  authenticate,
  authorize({ resource: "documents", action: "read" }),
  async (req, res, next) => {
    try {
      const isAgent = isAgentRole(req.auth.role);
      if (!isStaffRole(req.auth.role) && !isAgent) {
        const e = new Error("Insufficient permissions");
        e.status = 403;
        throw e;
      }
      await ensureDocumentSchema();
      const pool = getPool();
      const search = req.query.search?.trim();
      const statusFilter = req.query.documentStatus?.trim();
      const isEmployee = req.auth.role === "employee";
      let having = "";
      const params = {};
      if (statusFilter && statusFilter !== "all") {
        having = "HAVING document_summary_status = :doc_status";
        params.doc_status = statusFilter;
      }
      let searchClause = "";
      if (search) {
        const phoneDigits = search.replace(/\D/g, "");
        searchClause = `AND (
          la.application_number LIKE CAST(:search AS TEXT)
          OR la.id LIKE CAST(:search AS TEXT)
          OR up.full_name LIKE CAST(:search AS TEXT)
          OR up.email LIKE CAST(:search AS TEXT)
          OR up.phone LIKE CAST(:search AS TEXT)
          OR REPLACE(REPLACE(REPLACE(up.phone, ' ', ''), '-', ''), '+', '') LIKE :phone_digits
        )`;
        params.search = `%${search}%`;
        params.phone_digits = `%${phoneDigits || search}%`;
      }
      let employeeClause = "";
      if (isEmployee) {
        await assertEmployeeAccess(req, "documents", "read");
        const allowedAppIds = await fetchEmployeeOwnedApplicationIds(pool, req.auth.userId);
        if (!allowedAppIds.size) {
          return res.json([]);
        }
        const appIdParams = {};
        const appIdPlaceholders = Array.from(allowedAppIds).map((id, i) => {
          appIdParams[`employee_app_id_${i}`] = id;
          return `:employee_app_id_${i}`;
        });
        employeeClause = `AND la.id IN (${appIdPlaceholders.join(", ")})`;
        Object.assign(params, appIdParams);
      }
      const agentClause = isAgent ? `AND ${agentApplicationScopeSql("la")}` : "";
      if (isAgent) {
        Object.assign(params, await resolveAgentScopeParams(pool, req.auth.userId));
      }
      const [rows] = await pool.execute(
        `SELECT
           la.id AS application_id,
           la.customer_id,
           la.application_number,
           la.status AS application_status,
           la.created_at AS application_created_at,
           la.sourced_agent_code,
           up.full_name AS customer_name,
           up.email AS customer_email,
           up.phone AS customer_phone,
           COUNT(cd.id) AS total_docs,
           SUM(CASE WHEN COALESCE(cd.verification_status, cd.status, 'pending') IN ('pending','uploaded') THEN 1 ELSE 0 END) AS pending_docs,
           SUM(CASE WHEN COALESCE(cd.verification_status, cd.status, 'pending') IN ('approved','verified') THEN 1 ELSE 0 END) AS approved_docs,
           SUM(CASE WHEN COALESCE(cd.verification_status, cd.status, 'pending') = 'rejected' THEN 1 ELSE 0 END) AS rejected_docs,
           CASE
             WHEN COUNT(cd.id) = 0 THEN 'no_documents'
             WHEN SUM(CASE WHEN COALESCE(cd.verification_status, cd.status, 'pending') = 'rejected' THEN 1 ELSE 0 END) > 0 THEN 'has_rejected'
             WHEN SUM(CASE WHEN COALESCE(cd.verification_status, cd.status, 'pending') IN ('pending','uploaded') THEN 1 ELSE 0 END) > 0 THEN 'pending_review'
             WHEN SUM(CASE WHEN COALESCE(cd.verification_status, cd.status, 'pending') IN ('approved','verified') THEN 1 ELSE 0 END) = COUNT(cd.id) THEN 'all_approved'
             ELSE 'in_review'
           END AS document_summary_status
         FROM loan_applications la
         LEFT JOIN user_profiles up ON up.id = la.customer_id
         LEFT JOIN customer_documents cd ON cd.application_id = la.id
         WHERE 1=1 ${employeeClause} ${agentClause} ${searchClause}
         GROUP BY la.id, la.customer_id, la.application_number, la.status, la.created_at,
                  la.sourced_agent_code, up.full_name, up.email, up.phone
         ${having}
         ORDER BY la.created_at DESC`,
        params
      );
      res.json(
        rows.map((row) => ({
          application_id: row.application_id,
          customer_id: row.customer_id,
          application_number: row.application_number,
          sourced_agent_code: row.sourced_agent_code,
          application_status: row.application_status,
          application_created_at: row.application_created_at,
          customer_name: row.customer_name,
          customer_email: row.customer_email,
          customer_phone: row.customer_phone,
          total_docs: Number(row.total_docs) || 0,
          pending_docs: Number(row.pending_docs) || 0,
          approved_docs: Number(row.approved_docs) || 0,
          rejected_docs: Number(row.rejected_docs) || 0,
          document_summary_status: row.document_summary_status || summarizeApplicationDocStatus(row)
        }))
      );
    } catch (err) {
      next(err);
    }
  }
);
documentsRouter.get(
  "/",
  authenticate,
  authorize({
    resource: "documents",
    action: "read",
    getOwnerId: (req) => req.query.customerId || req.auth.userId
  }),
  async (req, res, next) => {
    try {
      await ensureDocumentSchema();
      const pool = getPool();
      const applicationId = req.query.applicationId || null;
      const customerId = req.query.customerId || null;
      const isStaff = isStaffRole(req.auth.role);
      let conditions = [];
      const params = {};
      const col = (name) => `cd.${name}`;
      if (applicationId) {
        conditions.push(`${col("application_id")} = :application_id`);
        params.application_id = applicationId;
        if (!isStaff && req.auth.role === "customer") {
          conditions.push(`${col("customer_id")} = :customer_id`);
          params.customer_id = req.auth.userId;
        }
        if (req.auth.role === "agent") {
          const appRow = await agentCanAccessApplication(pool, req.auth.userId, applicationId);
          if (!appRow) {
            const e = new Error("Insufficient permissions");
            e.status = 403;
            throw e;
          }
        }
      } else if (req.auth.role === "agent") {
        const scope = await resolveAgentScopeParams(pool, req.auth.userId);
        conditions.push(
          `${col("application_id")} IN (SELECT id FROM loan_applications WHERE ${agentApplicationScopeSql("loan_applications")})`
        );
        Object.assign(params, scope);
      } else if (req.auth.role === "employee") {
        await assertEmployeeAccess(req, "documents", "read");
        const allowedAppIds = await fetchEmployeeOwnedApplicationIds(pool, req.auth.userId);
        if (!allowedAppIds.size) {
          return res.json([]);
        }
        const idParams = {};
        const idPlaceholders = Array.from(allowedAppIds).map((id, i) => {
          idParams[`app_id_${i}`] = id;
          return `:app_id_${i}`;
        });
        conditions.push(`${col("application_id")} IN (${idPlaceholders.join(", ")})`);
        Object.assign(params, idParams);
        if (req.query.status === "pending") {
          conditions.push(
            `COALESCE(${col("verification_status")}, ${col("status")}, 'pending') IN ('pending','uploaded')`
          );
        }
      } else if (isStaff && customerId) {
        conditions.push(`${col("customer_id")} = :customer_id`);
        params.customer_id = customerId;
      } else if (isStaff) {
      } else {
        const ownerId = customerId || req.auth.userId;
        if (ownerId !== req.auth.userId && req.auth.role === "customer") {
          const e = new Error("Insufficient permissions");
          e.status = 403;
          throw e;
        }
        conditions.push(`${col("customer_id")} = :customer_id`);
        params.customer_id = ownerId;
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const [rows] = await pool.execute(
        `SELECT cd.*, la.application_number
         FROM customer_documents cd
         LEFT JOIN loan_applications la ON la.id = cd.application_id
         ${where}
         ORDER BY cd.uploaded_at DESC`,
        params
      );
      res.json(rows.map(formatDocumentRow));
    } catch (err) {
      next(err);
    }
  }
);
documentsRouter.post(
  "/",
  authenticate,
  authorize({
    resource: "documents",
    action: "update",
    getOwnerId: (req) => req.body.customerId || req.auth.userId
  }),
  ...spreadUpload(documentUpload, "single", "file"),
  async (req, res, next) => {
    try {
      const file = req.file;
      if (!file) {
        const e = new Error("Missing file");
        e.status = 400;
        throw e;
      }
      const docId = newId();
      const pool = getPool();
      let customerId = req.body.customerId || req.auth.userId;
      const applicationId = req.body.applicationId || null;
      const documentType = req.body.documentType || null;
      if (req.auth.role === "agent") {
        if (!applicationId) {
          return res.status(400).json({ error: "applicationId is required for agent uploads" });
        }
        const appRow = await agentCanAccessApplication(pool, req.auth.userId, applicationId);
        if (!appRow) {
          return res.status(403).json({ error: "You can only upload documents for applications you sourced" });
        }
        customerId = appRow.customer_id || customerId;
      }
      if (applicationId && documentType) {
        const requirements = await resolveRequirementsForApplication(pool, applicationId);
        if (requirements.length) {
          const normalizedDocType = String(documentType).replace(/^co_applicant_/, "").toLowerCase();
          const requirement = requirements.find(
            (item) => String(item.document_type || "").toLowerCase() === normalizedDocType
          );
          if (requirement) {
            const allowed = normalizeAllowedTypes(requirement.allowed_file_types_json);
            if (allowed.length) {
              const fileType = mimeToShortType(file.mimetype);
              if (!allowed.includes(fileType) && !allowed.includes(file.mimetype.toLowerCase())) {
                return res.status(400).json({
                  error: `Invalid file type for ${requirement.title}. Allowed: ${allowed.join(", ")}`
                });
              }
            }
          }
        }
      }
      const storedFileName = file.storedPath || (file.filename ? `/uploads/${String(file.filename).replace(/^\/uploads\//, "")}` : null) || basename(file.path || "");
      const filePath = storedFileName;
      const documentUrl = `/documents/${docId}/download`;
      await pool.execute(
        `INSERT INTO customer_documents
         (id, customer_id, application_id, document_type, document_name, file_path, document_url, file_size, mime_type, status, uploaded_by, uploaded_at)
         VALUES
         (:id, :customer_id, :application_id, :document_type, :document_name, :file_path, :document_url, :file_size, :mime_type, 'pending', :uploaded_by, :uploaded_at)`,
        {
          id: docId,
          customer_id: customerId,
          application_id: applicationId,
          document_type: documentType,
          document_name: file.originalname,
          file_path: filePath,
          document_url: documentUrl,
          file_size: file.size,
          mime_type: file.mimetype,
          uploaded_by: req.auth.userId,
          uploaded_at: /* @__PURE__ */ new Date()
        }
      );
      const [[doc]] = await pool.execute(`SELECT * FROM customer_documents WHERE id = :id`, { id: docId });
      if (applicationId) {
        await autoAssignApplicationsForEmployeeVerification(pool);
        dispatchFileUpdateNotification("customer_document_upload", {
          applicationId,
          extra: {
            title: "New document uploaded",
            message: `Customer uploaded ${documentType || file.originalname} for review.`
          }
        }).catch(() => {
        });
      }
      res.status(201).json(formatDocumentRow(doc));
    } catch (err) {
      next(err);
    }
  }
);
documentsRouter.get(
  "/:id/download",
  authenticate,
  authorize({
    resource: "documents",
    action: "read",
    getOwnerId: async (req) => {
      const pool = getPool();
      const [[doc]] = await pool.execute(
        `SELECT customer_id FROM customer_documents WHERE id = :id LIMIT 1`,
        { id: req.params.id }
      );
      return doc?.customer_id;
    }
  }),
  async (req, res, next) => {
    try {
      const pool = getPool();
      const [[doc]] = await pool.execute(`SELECT * FROM customer_documents WHERE id = :id LIMIT 1`, {
        id: req.params.id
      });
      if (!doc) return res.status(404).json({ error: "Document not found" });
      if (req.auth.role === "agent") {
        const appRow = await agentCanAccessApplication(pool, req.auth.userId, doc.application_id);
        if (!appRow) {
          return res.status(403).json({ error: "Insufficient permissions" });
        }
      }
      const opened = await streamStoredUpload(doc.file_path, [doc.document_name, doc.document_url]);
      if (!opened?.stream) {
        return res.status(404).json({
          error: "Document file not found on server. The file may need to be re-uploaded by the customer."
        });
      }
      const filename = doc.document_name || normalizeStoredUploadName(doc.file_path) || "document";
      const inline = req.query.inline === "1" || req.query.inline === "true";
      res.setHeader("Content-Type", doc.mime_type || opened.contentType || "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        `${inline ? "inline" : "attachment"}; filename="${filename.replace(/"/g, "")}"`
      );
      opened.stream.pipe(res);
    } catch (err) {
      next(err);
    }
  }
);
const VerifyDocumentSchema = z.object({
  status: z.enum(["pending", "uploaded", "approved", "rejected"]),
  verification_notes: z.string().optional(),
  verificationNotes: z.string().optional()
});
documentsRouter.post(
  "/:id/ocr",
  authenticate,
  authorize({ resource: "documents", action: "update" }),
  async (req, res, next) => {
    try {
      if (!isStaffRole(req.auth.role) || isAgentRole(req.auth.role)) {
        const e = new Error("Insufficient permissions");
        e.status = 403;
        throw e;
      }
      const { runDocumentOcr } = await import("../lib/documentOcr.js");
      const profile = req.body?.profile || {};
      const extractedText = req.body?.extractedText || req.body?.text || null;
      const result = await runDocumentOcr(req.params.id, { profile, extractedText });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);
documentsRouter.patch(
  "/:id/verification",
  authenticate,
  authorize({ resource: "documents", action: "update" }),
  async (req, res, next) => {
    try {
      if (!isStaffRole(req.auth.role) || isAgentRole(req.auth.role)) {
        const e = new Error("Insufficient permissions");
        e.status = 403;
        throw e;
      }
      if (req.auth.role === "employee") {
        const access = await getEffectiveEmployeeAccess(req.auth.userId);
        const inputPreview = VerifyDocumentSchema.parse(req.body);
        if (inputPreview.status === "approved") {
          requireEmployeeModuleAccess(access, "documents", "approve");
        } else if (inputPreview.status === "rejected") {
          requireEmployeeModuleAccess(access, "documents", "reject");
        } else {
          requireEmployeeModuleAccess(access, "documents", "write");
        }
      }
      await ensureDocumentSchema();
      const input = VerifyDocumentSchema.parse(req.body);
      const notes = input.verification_notes ?? input.verificationNotes ?? null;
      const pool = getPool();
      const [[existing]] = await pool.execute(
        `SELECT * FROM customer_documents WHERE id = :id LIMIT 1`,
        { id: req.params.id }
      );
      if (!existing) return res.status(404).json({ error: "Document not found" });
      await pool.execute(
        `UPDATE customer_documents
         SET verification_status = :status,
             status = :status,
             verification_notes = :notes,
             verified_by = :verified_by,
             verified_at = NOW()
         WHERE id = :id`,
        {
          id: req.params.id,
          status: input.status,
          notes,
          verified_by: req.auth.userId
        }
      );
      const [[row]] = await pool.execute(`SELECT * FROM customer_documents WHERE id = :id`, {
        id: req.params.id
      });
      await writeAuditLog({
        userId: req.auth.userId,
        actionType: "VERIFY",
        tableName: "customer_documents",
        recordId: req.params.id,
        oldValues: {
          verification_status: existing.verification_status,
          status: existing.status
        },
        newValues: {
          verification_status: input.status,
          verification_notes: notes,
          verified_at: (/* @__PURE__ */ new Date()).toISOString()
        }
      });
      if (existing.application_id) {
        const docLabel = existing.document_type || existing.document_name || "document";
        let appNo = existing.application_id?.slice?.(0, 8) || "";
        try {
          const [[appRow]] = await pool.execute(
            `SELECT application_number FROM loan_applications WHERE id = :id LIMIT 1`,
            { id: existing.application_id }
          );
          appNo = appRow?.application_number || appNo;
        } catch {
        }
        let notifyTitle = `Document ${input.status}`;
        let notifyMessage = `Your ${docLabel} was ${input.status} by our team.`;
        if (input.status === "rejected") {
          notifyTitle = "Document rejected — please resubmit";
          notifyMessage = [
            `Your ${docLabel} for application ${appNo} was rejected during verification.`,
            notes ? `Reason: ${notes}` : null,
            "Please log in to your customer portal, upload a corrected document, and resubmit your application data.",
            "Need help? Contact support@rfincare.com or use in-app chat."
          ].filter(Boolean).join("\n\n");
          try {
            await pool.execute(
              `UPDATE loan_applications
               SET status = 'documents_pending', updated_at = NOW()
               WHERE id = :id AND status NOT IN ('approved', 'disbursed', 'rejected')`,
              { id: existing.application_id }
            );
          } catch {
          }
        } else if (input.status === "approved") {
          notifyTitle = "Document approved";
          notifyMessage = `Your ${docLabel} for application ${appNo} has been verified and approved.`;
        }
        dispatchFileUpdateNotification("employee_document_decision", {
          applicationId: existing.application_id,
          extra: {
            title: notifyTitle,
            message: notifyMessage
          }
        }).catch(() => {
        });
        try {
          await createCustomerNotification(getPool(), {
            customerId: existing.customer_id,
            title: notifyTitle,
            message: notifyMessage
          });
        } catch {
        }
      }
      res.json(formatDocumentRow(row));
    } catch (err) {
      next(err);
    }
  }
);
documentsRouter.delete(
  "/:id",
  authenticate,
  authorize({
    resource: "documents",
    action: "update",
    getOwnerId: async (req) => {
      const pool = getPool();
      const [[doc]] = await pool.execute(
        `SELECT customer_id FROM customer_documents WHERE id = :id LIMIT 1`,
        { id: req.params.id }
      );
      return doc?.customer_id;
    }
  }),
  async (req, res, next) => {
    try {
      const pool = getPool();
      if (isAgentRole(req.auth.role)) {
        const [[doc]] = await pool.execute(
          `SELECT id, application_id FROM customer_documents WHERE id = :id LIMIT 1`,
          { id: req.params.id }
        );
        if (!doc) {
          const e = new Error("Document not found");
          e.status = 404;
          throw e;
        }
        const allowed = await agentCanAccessApplication(pool, req.auth.userId, doc.application_id);
        if (!allowed) {
          const e = new Error("Insufficient permissions");
          e.status = 403;
          throw e;
        }
      }
      await pool.execute(`DELETE FROM customer_documents WHERE id = :id`, { id: req.params.id });
      res.json({ ok: true, deleted: 1 });
    } catch (err) {
      next(err);
    }
  }
);
documentsRouter.post(
  "/bulk-delete",
  authenticate,
  async (req, res, next) => {
    try {
      const body = z.object({
        documentIds: z.array(z.string().min(1)).optional(),
        applicationIds: z.array(z.string().min(1)).optional()
      }).parse(req.body || {});
      const documentIds = [...new Set((body.documentIds || []).filter(Boolean))];
      const applicationIds = [...new Set((body.applicationIds || []).filter(Boolean))];
      if (!documentIds.length && !applicationIds.length) {
        return res.status(400).json({ error: "Provide documentIds and/or applicationIds" });
      }
      const role = req.auth.role;
      const canStaffDelete = isStaffRole(role) || hasPermission(role, "update:documents") || hasPermission(role, "update:*");
      const isAgent = isAgentRole(role);
      if (!canStaffDelete && !isAgent) {
        const e = new Error("Insufficient permissions");
        e.status = 403;
        throw e;
      }
      if (role === "employee") {
        await assertEmployeeAccess(req, "documents", "write");
      }
      const pool = getPool();
      await ensureDocumentSchema();
      let idsToDelete = [...documentIds];
      if (applicationIds.length) {
        if (isAgent) {
          const scope = await resolveAgentScopeParams(pool, req.auth.userId);
          const appParams = {};
          const appPlaceholders = applicationIds.map((id, i) => {
            const key = `app_${i}`;
            appParams[key] = id;
            return `:${key}`;
          });
          const [allowedApps] = await pool.execute(
            `SELECT id FROM loan_applications
             WHERE id IN (${appPlaceholders.join(", ")})
               AND ${agentApplicationScopeSql("loan_applications")}`,
            { ...appParams, ...scope }
          );
          const allowedSet = new Set((allowedApps || []).map((r) => r.id));
          const scopedAppIds = applicationIds.filter((id) => allowedSet.has(id));
          if (scopedAppIds.length) {
            const p = {};
            const ph = scopedAppIds.map((id, i) => {
              const key = `dapp_${i}`;
              p[key] = id;
              return `:${key}`;
            });
            const [rows] = await pool.execute(
              `SELECT id FROM customer_documents WHERE application_id IN (${ph.join(", ")})`,
              p
            );
            idsToDelete.push(...(rows || []).map((r) => r.id));
          }
        } else {
          const p = {};
          const ph = applicationIds.map((id, i) => {
            const key = `dapp_${i}`;
            p[key] = id;
            return `:${key}`;
          });
          const [rows] = await pool.execute(
            `SELECT id FROM customer_documents WHERE application_id IN (${ph.join(", ")})`,
            p
          );
          idsToDelete.push(...(rows || []).map((r) => r.id));
        }
      }
      idsToDelete = [...new Set(idsToDelete.filter(Boolean))];
      if (!idsToDelete.length) {
        return res.json({ ok: true, deleted: 0 });
      }
      if (isAgent) {
        const scope = await resolveAgentScopeParams(pool, req.auth.userId);
        const p = {};
        const ph = idsToDelete.map((id, i) => {
          const key = `doc_${i}`;
          p[key] = id;
          return `:${key}`;
        });
        const [owned] = await pool.execute(
          `SELECT cd.id
           FROM customer_documents cd
           JOIN loan_applications la ON la.id = cd.application_id
           WHERE cd.id IN (${ph.join(", ")})
             AND ${agentApplicationScopeSql("la")}`,
          { ...p, ...scope }
        );
        idsToDelete = (owned || []).map((r) => r.id);
        if (!idsToDelete.length) {
          const e = new Error("Insufficient permissions");
          e.status = 403;
          throw e;
        }
      }
      const delParams = {};
      const delPh = idsToDelete.map((id, i) => {
        const key = `del_${i}`;
        delParams[key] = id;
        return `:${key}`;
      });
      const [result] = await pool.execute(
        `DELETE FROM customer_documents WHERE id IN (${delPh.join(", ")})`,
        delParams
      );
      const deleted = Number(result?.affectedRows ?? result?.rowCount ?? idsToDelete.length);
      res.json({ ok: true, deleted, documentIds: idsToDelete });
    } catch (err) {
      next(err);
    }
  }
);
export {
  documentsRouter
};
