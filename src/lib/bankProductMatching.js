const LOAN_TYPE_ALIASES = {
  personal: 'personal_loan',
  home: 'home_loan',
  business: 'business_loan',
  auto: 'auto_loan',
  car: 'auto_loan',
  education: 'education_loan',
  personal_loan: 'personal_loan',
  home_loan: 'home_loan',
  business_loan: 'business_loan',
  auto_loan: 'auto_loan',
  car_loan: 'auto_loan',
  education_loan: 'education_loan',
  loan_against_property: 'home_loan',
  mortgage_loan: 'home_loan',
  two_wheeler_loan: 'auto_loan',
  consumer_loan: 'personal_loan',
  overdraft: 'business_loan',
  cc_limit: 'business_loan',
  kisan_credit_card: 'business_loan',
  credit_card: 'personal_loan',
  unsecured_cc_limit: 'business_loan',
  unsecured_overdraft_limit: 'business_loan',
};

const BASE_CATEGORY_SLUGS = new Set(['personal', 'home', 'business', 'auto', 'education']);

function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
}

export function parseProductData(data) {
  if (!data) return {};
  if (typeof data === 'object') return data;
  try {
    return JSON.parse(data);
  } catch {
    return {};
  }
}

export function getProductCategoryFields(product) {
  const d = parseProductData(product?.data);
  return {
    loanType: normalizeKey(d.loan_type || d.loanType || d.type || d.productType),
    categorySlug: normalizeKey(
      d.product_category_slug ||
        d.productCategorySlug ||
        d.catalog_slug ||
        d.catalogSlug ||
        '',
    ),
    categoryApiKey: normalizeKey(
      d.catalog_api_key || d.catalogApiKey || d.product_category_api_key || '',
    ),
  };
}

/**
 * @param {import('pg').Pool} pool
 */
export async function resolveProductCategoryQuery(pool, rawQuery) {
  if (!rawQuery) return null;
  const key = normalizeKey(rawQuery);

  if (LOAN_TYPE_ALIASES[key]) {
    const slug = key.replace(/_loan$/, '') || key;
    return {
      slug,
      apiKey: LOAN_TYPE_ALIASES[key],
      isBaseCategory: BASE_CATEGORY_SLUGS.has(slug),
    };
  }

  try {
    const [[row]] = await pool.execute(
      `SELECT slug, api_key FROM loan_product_catalog
       WHERE is_active = TRUE
         AND (
           LOWER(slug) = :key
           OR LOWER(api_key) = :key
           OR LOWER(slug) = :raw
           OR LOWER(api_key) = :raw
         )
       LIMIT 1`,
      { key, raw: String(rawQuery).trim().toLowerCase() },
    );
    if (row) {
      const slug = normalizeKey(row.slug);
      return {
        slug,
        apiKey: normalizeKey(row.api_key),
        isBaseCategory: BASE_CATEGORY_SLUGS.has(slug),
      };
    }

    const [[catRow]] = await pool.execute(
      `SELECT slug, parent_loan_type FROM product_categories
       WHERE is_active = TRUE
         AND (LOWER(slug) = :key OR LOWER(slug) = :raw)
       LIMIT 1`,
      { key, raw: String(rawQuery).trim().toLowerCase() },
    );
    if (catRow) {
      const slug = normalizeKey(catRow.slug);
      const parent = normalizeKey(catRow.parent_loan_type);
      return {
        slug,
        apiKey: parent || (slug.endsWith('_loan') ? slug : `${slug}_loan`),
        isBaseCategory: BASE_CATEGORY_SLUGS.has(slug),
      };
    }
  } catch {
    /* catalog optional at runtime */
  }

  if (key.endsWith('_loan')) {
    const slug = key.replace(/_loan$/, '');
    return {
      slug,
      apiKey: key,
      isBaseCategory: BASE_CATEGORY_SLUGS.has(slug),
    };
  }

  return {
    slug: key,
    apiKey: `${key}_loan`,
    isBaseCategory: false,
  };
}

export function bankProductMatchesCategory(product, category) {
  if (!category) return true;

  const { loanType, categorySlug, categoryApiKey } = getProductCategoryFields(product);
  const catSlug = normalizeKey(category.slug);
  const catApiKey = normalizeKey(category.apiKey);
  const productHasSubcategory = Boolean(categorySlug || categoryApiKey);

  if (!category.isBaseCategory) {
    if (categorySlug && categorySlug === catSlug) return true;
    if (categoryApiKey && categoryApiKey === catApiKey) return true;
    if (!categorySlug && !categoryApiKey && loanType === catApiKey) return true;
    return false;
  }

  if (categorySlug && categorySlug === catSlug) return true;
  if (categoryApiKey && categoryApiKey === catApiKey) return true;

  if (loanType === catApiKey) {
    return !productHasSubcategory;
  }

  return false;
}
