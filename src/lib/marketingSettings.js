import { getPool, isDuplicateEntryError } from '../db/pool.js';
import { newId } from './ids.js';

const SETTINGS_ID = 'default';
let ensured = false;

const DEFAULTS = {
  gaMeasurementId: '',
  gtmContainerId: '',
  gaEnabled: false,
  metaPixelId: '',
  metaPixelEnabled: false,
  metaConversionsApiToken: '',
  customHeadHtml: '',
  customBodyHtml: '',
  seoSiteName: 'Rfincare',
  seoDefaultTitle: 'Rfincare - Your Trusted Loan Partner',
  seoDefaultDescription:
    'Rfincare - Simplifying loan applications with personalized financial solutions across India',
  seoKeywords: 'loans, personal loan, home loan, business loan, India, Rfincare',
  seoOgImage: '',
  seoTwitterCard: 'summary_large_image',
  seoCanonicalUrl: '',
  seoRobots: 'index,follow',
  googleSiteVerification: '',
  pageSeo: [],
  adCampaigns: [],
  customTags: [],
};

function parseJsonArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatRow(row) {
  if (!row) return { ...DEFAULTS };
  return {
    gaMeasurementId: row.ga_measurement_id || '',
    gtmContainerId: row.gtm_container_id || '',
    gaEnabled: !!row.ga_enabled,
    metaPixelId: row.meta_pixel_id || '',
    metaPixelEnabled: !!row.meta_pixel_enabled,
    metaConversionsApiToken: row.meta_conversions_api_token || '',
    customHeadHtml: row.custom_head_html || '',
    customBodyHtml: row.custom_body_html || '',
    seoSiteName: row.seo_site_name || DEFAULTS.seoSiteName,
    seoDefaultTitle: row.seo_default_title || DEFAULTS.seoDefaultTitle,
    seoDefaultDescription: row.seo_default_description || DEFAULTS.seoDefaultDescription,
    seoKeywords: row.seo_keywords || DEFAULTS.seoKeywords,
    seoOgImage: row.seo_og_image || '',
    seoTwitterCard: row.seo_twitter_card || DEFAULTS.seoTwitterCard,
    seoCanonicalUrl: row.seo_canonical_url || '',
    seoRobots: row.seo_robots || DEFAULTS.seoRobots,
    googleSiteVerification: row.google_site_verification || '',
    pageSeo: parseJsonArray(row.page_seo_json),
    adCampaigns: parseJsonArray(row.ad_campaigns_json),
    customTags: parseJsonArray(row.custom_tags_json),
    updatedAt: row.updated_at,
  };
}

/** Public-safe payload (no secrets). */
export function formatPublicMarketingSettings(settings) {
  return {
    gaMeasurementId: settings.gaEnabled ? settings.gaMeasurementId : '',
    gtmContainerId: settings.gaEnabled ? settings.gtmContainerId : '',
    gaEnabled: settings.gaEnabled,
    metaPixelId: settings.metaPixelEnabled ? settings.metaPixelId : '',
    metaPixelEnabled: settings.metaPixelEnabled,
    customHeadHtml: settings.customHeadHtml,
    customBodyHtml: settings.customBodyHtml,
    seoSiteName: settings.seoSiteName,
    seoDefaultTitle: settings.seoDefaultTitle,
    seoDefaultDescription: settings.seoDefaultDescription,
    seoKeywords: settings.seoKeywords,
    seoOgImage: settings.seoOgImage,
    seoTwitterCard: settings.seoTwitterCard,
    seoCanonicalUrl: settings.seoCanonicalUrl,
    seoRobots: settings.seoRobots,
    googleSiteVerification: settings.googleSiteVerification,
    pageSeo: settings.pageSeo,
    adCampaigns: (settings.adCampaigns || []).filter((c) => c?.active !== false),
    customTags: (settings.customTags || []).filter((t) => t?.enabled !== false),
    updatedAt: settings.updatedAt,
  };
}

export async function ensureMarketingSchema() {
  ensured = true;
}

export async function getMarketingSettings() {
  await ensureMarketingSchema();
  const pool = getPool();
  const [[row]] = await pool.execute(
    `SELECT * FROM marketing_settings WHERE id = :id LIMIT 1`,
    { id: SETTINGS_ID },
  );
  return formatRow(row);
}

export async function getPublicMarketingSettings() {
  return formatPublicMarketingSettings(await getMarketingSettings());
}

export async function updateMarketingSettings(input, updatedBy) {
  await ensureMarketingSchema();
  const pool = getPool();

  const pageSeo = parseJsonArray(input.pageSeo);
  const adCampaigns = parseJsonArray(input.adCampaigns);
  const customTags = parseJsonArray(input.customTags);

  await pool.execute(
    `INSERT INTO marketing_settings (
       id, ga_measurement_id, gtm_container_id, ga_enabled,
       meta_pixel_id, meta_pixel_enabled, meta_conversions_api_token,
       custom_head_html, custom_body_html,
       seo_site_name, seo_default_title, seo_default_description, seo_keywords,
       seo_og_image, seo_twitter_card, seo_canonical_url, seo_robots,
       google_site_verification, page_seo_json, ad_campaigns_json, custom_tags_json,
       updated_by
     ) VALUES (
       :id, :ga_id, :gtm_id, :ga_enabled,
       :meta_pixel_id, :meta_pixel_enabled, :meta_token,
       :head_html, :body_html,
       :seo_site, :seo_title, :seo_desc, :seo_keywords,
       :seo_og, :seo_twitter, :seo_canonical, :seo_robots,
       :google_verify, :page_seo, :campaigns, :tags,
       :updated_by
     ) ON CONFLICT (id) DO UPDATE SET ga_measurement_id = EXCLUDED.ga_measurement_id,
       gtm_container_id = EXCLUDED.gtm_container_id,
       ga_enabled = EXCLUDED.ga_enabled,
       meta_pixel_id = EXCLUDED.meta_pixel_id,
       meta_pixel_enabled = EXCLUDED.meta_pixel_enabled,
       meta_conversions_api_token = COALESCE(NULLIF(EXCLUDED.meta_conversions_api_token, ''), meta_conversions_api_token),
       custom_head_html = EXCLUDED.custom_head_html,
       custom_body_html = EXCLUDED.custom_body_html,
       seo_site_name = EXCLUDED.seo_site_name,
       seo_default_title = EXCLUDED.seo_default_title,
       seo_default_description = EXCLUDED.seo_default_description,
       seo_keywords = EXCLUDED.seo_keywords,
       seo_og_image = EXCLUDED.seo_og_image,
       seo_twitter_card = EXCLUDED.seo_twitter_card,
       seo_canonical_url = EXCLUDED.seo_canonical_url,
       seo_robots = EXCLUDED.seo_robots,
       google_site_verification = EXCLUDED.google_site_verification,
       page_seo_json = EXCLUDED.page_seo_json,
       ad_campaigns_json = EXCLUDED.ad_campaigns_json,
       custom_tags_json = EXCLUDED.custom_tags_json,
       updated_by = EXCLUDED.updated_by`,
    {
      id: SETTINGS_ID,
      ga_id: input.gaMeasurementId || null,
      gtm_id: input.gtmContainerId || null,
      ga_enabled: input.gaEnabled ? 1 : 0,
      meta_pixel_id: input.metaPixelId || null,
      meta_pixel_enabled: input.metaPixelEnabled ? 1 : 0,
      meta_token: input.metaConversionsApiToken || null,
      head_html: input.customHeadHtml || null,
      body_html: input.customBodyHtml || null,
      seo_site: input.seoSiteName || DEFAULTS.seoSiteName,
      seo_title: input.seoDefaultTitle || DEFAULTS.seoDefaultTitle,
      seo_desc: input.seoDefaultDescription || DEFAULTS.seoDefaultDescription,
      seo_keywords: input.seoKeywords || DEFAULTS.seoKeywords,
      seo_og: input.seoOgImage || null,
      seo_twitter: input.seoTwitterCard || DEFAULTS.seoTwitterCard,
      seo_canonical: input.seoCanonicalUrl || null,
      seo_robots: input.seoRobots || DEFAULTS.seoRobots,
      google_verify: input.googleSiteVerification || null,
      page_seo: JSON.stringify(pageSeo),
      campaigns: JSON.stringify(adCampaigns),
      tags: JSON.stringify(customTags),
      updated_by: updatedBy ?? null,
    },
  );

  return getMarketingSettings();
}

export async function logMarketingEvent({
  eventName,
  platform = 'web',
  pagePath = null,
  utmSource = null,
  utmMedium = null,
  utmCampaign = null,
  utmContent = null,
  utmTerm = null,
  campaignId = null,
  payload = null,
}) {
  await ensureMarketingSchema();
  const pool = getPool();
  await pool.execute(
    `INSERT INTO marketing_events (
       id, event_name, platform, page_path,
       utm_source, utm_medium, utm_campaign, utm_content, utm_term,
       campaign_id, payload_json
     ) VALUES (
       :id, :event_name, :platform, :page_path,
       :utm_source, :utm_medium, :utm_campaign, :utm_content, :utm_term,
       :campaign_id, :payload_json
     )`,
    {
      id: newId(),
      event_name: eventName,
      platform,
      page_path: pagePath,
      utm_source: utmSource,
      utm_medium: utmMedium,
      utm_campaign: utmCampaign,
      utm_content: utmContent,
      utm_term: utmTerm,
      campaign_id: campaignId,
      payload_json: payload ? JSON.stringify(payload) : null,
    },
  );
}

export async function getMarketingEventStats({ days = 30 } = {}) {
  await ensureMarketingSchema();
  const pool = getPool();
  const dayWindow = Math.min(Math.max(Number(days) || 30, 1), 365);

  const [byCampaign] = await pool.execute(
    `SELECT utm_campaign AS campaign, utm_source AS source, utm_medium AS medium,
            COUNT(*) AS events,
            COUNT(DISTINCT DATE(created_at)) AS active_days
     FROM marketing_events
     WHERE created_at >= NOW() - (:days || ' days')::interval
       AND utm_campaign IS NOT NULL AND utm_campaign != ''
     GROUP BY utm_campaign, utm_source, utm_medium
     ORDER BY events DESC
     LIMIT 50`,
    { days: dayWindow },
  );

  const [byEvent] = await pool.execute(
    `SELECT event_name AS eventName, platform, COUNT(*) AS count
     FROM marketing_events
     WHERE created_at >= NOW() - (:days || ' days')::interval
     GROUP BY event_name, platform
     ORDER BY count DESC
     LIMIT 30`,
    { days: dayWindow },
  );

  const [recent] = await pool.execute(
    `SELECT id, event_name AS eventName, platform, page_path AS pagePath,
            utm_source AS utmSource, utm_medium AS utmMedium, utm_campaign AS utmCampaign,
            created_at AS createdAt
     FROM marketing_events
     ORDER BY created_at DESC
     LIMIT 100`,
  );

  const [[totals]] = await pool.execute(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN event_name = 'page_view' THEN 1 ELSE 0 END) AS pageViews,
            SUM(CASE WHEN event_name IN ('lead','conversion','apply_start','apply_complete') THEN 1 ELSE 0 END) AS conversions
     FROM marketing_events
     WHERE created_at >= NOW() - (:days || ' days')::interval`,
    { days: dayWindow },
  );

  return {
    days: dayWindow,
    totals: {
      total: Number(totals?.total || 0),
      pageViews: Number(totals?.pageViews || 0),
      conversions: Number(totals?.conversions || 0),
    },
    byCampaign,
    byEvent,
    recent,
  };
}