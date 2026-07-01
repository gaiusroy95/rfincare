import { getPool, isDuplicateEntryError } from '../db/pool.js';
import { newId } from './ids.js';

let ensured = false;

export const DEFAULT_PRODUCT_CATEGORIES = [
  { slug: 'personal_loan', label: 'Personal Loan', parent_loan_type: 'personal_loan', sort_order: 1 },
  { slug: 'home_loan', label: 'Home Loan', parent_loan_type: 'home_loan', sort_order: 2 },
  {
    slug: 'loan_against_property',
    label: 'Loan Against Property',
    parent_loan_type: 'home_loan',
    sort_order: 3,
  },
  { slug: 'mortgage_loan', label: 'Mortgage Loan', parent_loan_type: 'home_loan', sort_order: 4 },
  { slug: 'business_loan', label: 'Business Loan', parent_loan_type: 'business_loan', sort_order: 5 },
  { slug: 'car_loan', label: 'Car Loan', parent_loan_type: 'auto_loan', sort_order: 6 },
  { slug: 'two_wheeler_loan', label: 'Two Wheeler Loan', parent_loan_type: 'auto_loan', sort_order: 7 },
  { slug: 'consumer_loan', label: 'Consumer Loan', parent_loan_type: 'personal_loan', sort_order: 8 },
  { slug: 'overdraft', label: 'Overdraft', parent_loan_type: 'business_loan', sort_order: 9 },
  { slug: 'cc_limit', label: 'CC Limit', parent_loan_type: 'business_loan', sort_order: 10 },
  {
    slug: 'kisan_credit_card',
    label: 'Kisan Credit Card',
    parent_loan_type: 'business_loan',
    sort_order: 11,
  },
  { slug: 'credit_card', label: 'Credit Card', parent_loan_type: 'personal_loan', sort_order: 12 },
  {
    slug: 'unsecured_cc_limit',
    label: 'Unsecured CC Limit',
    parent_loan_type: 'business_loan',
    sort_order: 13,
  },
  {
    slug: 'unsecured_overdraft_limit',
    label: 'Unsecured Overdraft Limit',
    parent_loan_type: 'business_loan',
    sort_order: 14,
  },
  { slug: 'education_loan', label: 'Education Loan', parent_loan_type: 'education_loan', sort_order: 15 },
  { slug: 'auto_loan', label: 'Auto Loan', parent_loan_type: 'auto_loan', sort_order: 16 },
  { slug: 'school_loan', label: 'School Loan', parent_loan_type: 'business_loan', sort_order: 17 },
  { slug: 'equipment_loan', label: 'Equipment Loan', parent_loan_type: 'business_loan', sort_order: 18 },
];

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

export async function ensureProductCategorySchema() {
  if (ensured) return;
  const pool = getPool();

  for (const cat of DEFAULT_PRODUCT_CATEGORIES) {
    const [[existing]] = await pool.execute(
      `SELECT id FROM product_categories WHERE slug = :slug LIMIT 1`,
      { slug: cat.slug },
    );
    if (existing) continue;
    await pool.execute(
      `INSERT INTO product_categories (id, slug, label, parent_loan_type, sort_order, is_active)
       VALUES (:id, :slug, :label, :parent_loan_type, :sort_order, TRUE)`,
      { id: newId(), ...cat },
    );
  }

  ensured = true;
}

function formatCategoryRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    label: row.label,
    parentLoanType: row.parent_loan_type,
    sortOrder: row.sort_order ?? 0,
    isActive: Boolean(row.is_active),
  };
}

export async function listProductCategories({ includeInactive = false } = {}) {
  await ensureProductCategorySchema();
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT * FROM product_categories
     ${includeInactive ? '' : 'WHERE is_active = TRUE'}
     ORDER BY sort_order ASC, label ASC`,
  );
  return rows.map(formatCategoryRow);
}

export async function getProductCategoryById(id) {
  if (!id) return null;
  await ensureProductCategorySchema();
  const pool = getPool();
  const [[row]] = await pool.execute(
    `SELECT * FROM product_categories WHERE id = :id LIMIT 1`,
    { id },
  );
  return formatCategoryRow(row);
}

export async function createProductCategory({ label, slug: slugInput, parentLoanType }) {
  await ensureProductCategorySchema();
  const pool = getPool();
  const slug = slugify(slugInput || label);
  if (!slug) {
    const err = new Error('Invalid category name');
    err.status = 400;
    throw err;
  }
  const id = newId();
  try {
    await pool.execute(
      `INSERT INTO product_categories (id, slug, label, parent_loan_type, sort_order, is_active)
       VALUES (:id, :slug, :label, :parent_loan_type, :sort_order, TRUE)`,
      {
        id,
        slug,
        label: String(label).trim(),
        parent_loan_type: parentLoanType || null,
        sort_order: 99,
      },
    );
  } catch (err) {
    if (isDuplicateEntryError(err)) {
      const [[existing]] = await pool.execute(
        `SELECT * FROM product_categories WHERE slug = :slug LIMIT 1`,
        { slug },
      );
      return formatCategoryRow(existing);
    }
    throw err;
  }
  return getProductCategoryById(id);
}
