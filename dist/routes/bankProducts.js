import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { getPool } from "../db/pool.js";
import { cacheDeletePrefix } from "../lib/simpleCache.js";
const BANK_LIST_CACHE_PREFIX = "banks:list:";
const bankProductsRouter = Router();
function parseProductJson(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
function extractProductData(body = {}) {
  const src = body.data != null ? parseProductJson(body.data) : body;
  const merged = { ...src };
  delete merged.name;
  delete merged.bank_id;
  delete merged.bankId;
  delete merged.is_active;
  delete merged.isActive;
  delete merged.id;
  delete merged.data;
  const aliasPairs = [
    ["loanType", "loan_type"],
    ["productCategorySlug", "product_category_slug"],
    ["catalogApiKey", "catalog_api_key"],
    ["interestRateMin", "interest_rate_min"],
    ["interestRateMax", "interest_rate_max"],
    ["processingFeePercentage", "processing_fee_percentage"],
    ["processingFeeFixed", "processing_fee_fixed"],
    ["otherCharges", "other_charges"],
    ["prepaymentCharges", "prepayment_charges"],
    ["foreclosureCharges", "foreclosure_charges"],
    ["foreclosureFeePct", "foreclosure_fee_pct"],
    ["foreclosureAllowedAfterMonths", "foreclosure_allowed_after_months"],
    ["partPaymentFeePct", "part_payment_fee_pct"],
    ["bouncingCharges", "bouncing_charges"],
    ["lateFeePct", "late_fee_pct"],
    ["latePaymentFeeFixed", "late_payment_fee_fixed"],
    ["latePaymentCharges", "late_payment_charges"],
    ["documentationCharges", "documentation_charges"],
    ["maxLoanAmount", "max_loan_amount"],
    ["minLoanAmount", "min_loan_amount"],
    ["maxTenureYears", "max_tenure_years"],
    ["minTenureYears", "min_tenure_years"],
    ["disbursalTimeline", "disbursal_timeline"],
    ["collateralRequired", "collateral_required"],
    ["eligibilityCriteria", "eligibility_criteria"],
    ["documentationRequired", "documentation_required"],
    ["requiredDocuments", "documentation_required"],
    ["required_documents", "documentation_required"],
    ["applyUrl", "apply_url"]
  ];
  for (const [camel, snake] of aliasPairs) {
    if (merged[camel] !== void 0 && merged[snake] === void 0) {
      merged[snake] = merged[camel];
    }
  }
  return merged;
}
bankProductsRouter.patch(
  "/:id",
  authenticate,
  authorize({ resource: "bank_products", action: "manage" }),
  async (req, res, next) => {
    try {
      const pool = getPool();
      const [[existing]] = await pool.execute(
        `SELECT * FROM bank_products WHERE id = :id LIMIT 1`,
        { id: req.params.id }
      );
      if (!existing) {
        return res.status(404).json({ error: "Product not found" });
      }
      const current = parseProductJson(existing.data);
      const patch = extractProductData(req.body);
      const merged = { ...current, ...patch };
      const name = req.body?.name ?? existing.name;
      const isActive = req.body?.is_active !== void 0 ? req.body.is_active ? 1 : 0 : existing.is_active;
      await pool.execute(
        `UPDATE bank_products
         SET is_active = :is_active,
             name = :name,
             data = :data
         WHERE id = :id`,
        {
          id: req.params.id,
          is_active: isActive,
          name,
          data: JSON.stringify(merged)
        }
      );
      const [[row]] = await pool.execute(`SELECT * FROM bank_products WHERE id = :id`, {
        id: req.params.id
      });
      cacheDeletePrefix(BANK_LIST_CACHE_PREFIX);
      res.json(row);
    } catch (err) {
      next(err);
    }
  }
);
bankProductsRouter.delete(
  "/:id",
  authenticate,
  authorize({ resource: "bank_products", action: "manage" }),
  async (req, res, next) => {
    try {
      const pool = getPool();
      await pool.execute(`DELETE FROM bank_products WHERE id = :id`, { id: req.params.id });
      cacheDeletePrefix(BANK_LIST_CACHE_PREFIX);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);
export {
  bankProductsRouter
};
