import { getPool } from '../db/pool.js';
import { newId } from './ids.js';
import { cacheDeletePrefix } from './simpleCache.js';

const BANK_LIST_CACHE_PREFIX = 'banks:list:';

function parseProductData(data) {
  if (!data) return {};
  if (typeof data === 'object') return data;
  try {
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function productMatchesCategory(product, categorySlug) {
  const d = parseProductData(product.data);
  const slug = String(
    d.product_category_slug || d.productCategorySlug || d.catalog_slug || '',
  )
    .trim()
    .toLowerCase();
  return slug === String(categorySlug || '').trim().toLowerCase();
}

export async function syncCatalogBankProduct({
  catalogId,
  bankId,
  category,
  label,
  features,
  interestRateMin,
  interestRateMax,
  bankProductId,
}) {
  if (!bankId || !category?.slug) return bankProductId || null;

  const pool = getPool();
  const productData = {
    loan_type: category.parentLoanType || category.parent_loan_type || category.slug,
    product_category_slug: category.slug,
    catalog_api_key: category.slug,
    interest_rate_min: interestRateMin ?? null,
    interest_rate_max: interestRateMax ?? null,
    features: features || [],
  };

  let targetId = bankProductId || null;

  if (!targetId) {
    const [rows] = await pool.execute(
      `SELECT id, data FROM bank_products WHERE bank_id = :bankId AND is_active = TRUE`,
      { bankId },
    );
    const match = rows.find((row) => productMatchesCategory(row, category.slug));
    if (match) targetId = match.id;
  }

  if (targetId) {
    await pool.execute(
      `UPDATE bank_products SET name = :name, data = :data WHERE id = :id`,
      {
        id: targetId,
        name: label,
        data: JSON.stringify(productData),
      },
    );
  } else {
    targetId = newId();
    await pool.execute(
      `INSERT INTO bank_products (id, bank_id, name, is_active, data)
       VALUES (:id, :bankId, :name, 1, :data)`,
      {
        id: targetId,
        bankId,
        name: label,
        data: JSON.stringify(productData),
      },
    );
  }

  if (catalogId) {
    await pool.execute(
      `UPDATE loan_product_catalog SET bank_product_id = :bpId WHERE id = :id`,
      { id: catalogId, bpId: targetId },
    );
  }

  cacheDeletePrefix(BANK_LIST_CACHE_PREFIX);
  return targetId;
}

export async function ensureCategoryLandingCatalog(pool, category) {
  if (!category?.slug) return;
  const [[existing]] = await pool.execute(
    `SELECT id FROM loan_product_catalog
     WHERE slug = :slug AND bank_id IS NULL
     LIMIT 1`,
    { slug: category.slug },
  );
  if (existing) return;

  const apiKey = category.slug.endsWith('_loan') ? category.slug : `${category.slug}_loan`;
  await pool.execute(
    `INSERT INTO loan_product_catalog (
      id, slug, api_key, label, short_label, icon, description,
      category_id, bank_id, sort_order, is_active
    ) VALUES (
      :id, :slug, :api_key, :label, :short_label, 'Briefcase', :description,
      :category_id, NULL, :sort_order, 1
    )`,
    {
      id: newId(),
      slug: category.slug,
      api_key: apiKey,
      label: category.label,
      short_label: category.label.split(' ')[0],
      description: `${category.label} products from partner banks.`,
      category_id: category.id,
      sort_order: category.sortOrder ?? category.sort_order ?? 50,
    },
  );
}
