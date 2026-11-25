import { createHash } from 'node:crypto';

import { fetchWithTimeout } from './fetchWithTimeout.js';
import { isPdfBuffer, storeCibilReportPdf } from './cibilReportStore.js';

const PRODUCTION_BASE_URL = 'https://kyc-api.surepass.io';
const SANDBOX_BASE_URL = 'https://sandbox.surepass.io';

/**
 * Surepass uses "dev.<user>" identities for production tokens too, so the identity alone
 * cannot tell sandbox from production. Trial / sandbox tokens are short-lived (~30 days);
 * paid production tokens are long-lived (years).
 */
const PRODUCTION_MIN_LIFETIME_DAYS = 180;

/** Host learned from Surepass itself ("signature invalid — use the other host"), per token. */
const learnedEnvironment = new Map();

function tokenFingerprint(token) {
  return createHash('sha256').update(String(token || '')).digest('hex').slice(0, 24);
}

/** Surepass 401 meaning "valid token, wrong host (sandbox vs production)". */
function isWrongHostError(status, message) {
  return Number(status) === 401
    && /signature\)?\s*is invalid|being used in\s*'?(sandbox|kyc-api)/i.test(String(message || ''));
}

/** Surepass bureau PDF endpoints (POST, JSON body, Bearer token). */
const BUREAU_PATHS = {
  transunion_cibil: '/api/v1/credit-report-cibil/fetch-report-pdf',
  experian: '/api/v1/credit-report-experian/fetch-report-pdf',
};

/** Paths used by earlier builds that Surepass answers with 404. */
const LEGACY_PATHS = new Set([
  '/api/v1/credit-cibil-pdf-report',
  '/api/v1/credit-experian-pdf-report',
  '/api/v1/credit-report-cibil',
  '/api/v1/credit-report-cibil/pdf',
  '/api/v1/credit-report-experian',
  '/api/v1/credit-report-experian/pdf',
]);

let cachedToken = null;
let cachedTokenExpiresAt = 0;

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function decodeJwtClaims(token) {
  const part = String(token || '').split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Non-secret facts about the configured Surepass token (environment + expiry). */
export function getSurepassTokenInfo(token = env('SUREPASS_TOKEN')) {
  if (!token) return { configured: false };
  const claims = decodeJwtClaims(token);
  if (!claims) return { configured: true, environment: 'unknown' };
  const identity = String(claims.identity || claims.sub || '');
  const expiresAt = claims.exp ? new Date(claims.exp * 1000) : null;
  const lifetimeDays = claims.iat && claims.exp ? (claims.exp - claims.iat) / 86400 : null;
  let environment = learnedEnvironment.get(tokenFingerprint(token));
  if (!environment) {
    if (lifetimeDays != null && lifetimeDays > PRODUCTION_MIN_LIFETIME_DAYS) environment = 'production';
    else environment = identity.startsWith('dev.') ? 'sandbox' : 'production';
  }
  return {
    configured: true,
    environment,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    expired: Boolean(expiresAt && expiresAt.getTime() < Date.now()),
  };
}

function bureauKey(vendor = {}) {
  const key = String(vendor.vendor_key || vendor.vendorKey || '').toLowerCase();
  return key === 'experian' ? 'experian' : 'transunion_cibil';
}

export function getSurepassConfig(vendor = {}) {
  const key = bureauKey(vendor);
  const isExperian = key === 'experian';
  const envToken = env('SUREPASS_TOKEN');
  const bearerFromVendor = String(vendor.api_key || '').trim();
  // An expired (or sandbox) server token must not override a valid production token saved
  // under Admin → API Configuration — otherwise renewing the token in the portal has no effect.
  const envInfo = getSurepassTokenInfo(envToken);
  const vendorInfo = getSurepassTokenInfo(bearerFromVendor);
  const preferVendor = Boolean(bearerFromVendor) && !vendorInfo.expired && (
    !envToken
    || envInfo.expired
    || (vendorInfo.environment === 'production' && envInfo.environment === 'sandbox')
  );
  const token = preferVendor ? bearerFromVendor : envToken;
  const tokenInfo = getSurepassTokenInfo(token || bearerFromVendor);

  // Sandbox tokens are rejected by the production host and vice versa, so a token whose
  // environment is known always picks its own host; SUREPASS_BASE_URL only wins for custom gateways.
  const configuredBase = env('SUREPASS_BASE_URL').replace(/\/$/, '');
  const envSandbox = env('SUREPASS_SANDBOX', 'true') !== 'false';
  const isKnownHost = [PRODUCTION_BASE_URL, SANDBOX_BASE_URL].includes(configuredBase);
  let baseUrl;
  if (configuredBase && !isKnownHost) baseUrl = configuredBase;
  else if (tokenInfo.environment === 'production') baseUrl = PRODUCTION_BASE_URL;
  else if (tokenInfo.environment === 'sandbox') baseUrl = SANDBOX_BASE_URL;
  else baseUrl = configuredBase || (envSandbox ? SANDBOX_BASE_URL : PRODUCTION_BASE_URL);
  const sandbox =
    tokenInfo.environment === 'sandbox'
    || (tokenInfo.environment !== 'production' && (baseUrl === SANDBOX_BASE_URL || envSandbox));

  const envPath = env(isExperian ? 'SUREPASS_EXPERIAN_PATH' : 'SUREPASS_CIBIL_PATH');
  const normalizedEnvPath = envPath ? (envPath.startsWith('/') ? envPath : `/${envPath}`) : '';
  const paths = [
    ...(normalizedEnvPath && !LEGACY_PATHS.has(normalizedEnvPath) ? [normalizedEnvPath] : []),
    BUREAU_PATHS[key],
  ].filter((p, i, arr) => arr.indexOf(p) === i);

  return {
    baseUrl,
    paths,
    token,
    idNumber: env('SUREPASS_ID_NUMBER'),
    password: env('SUREPASS_PASSWORD') || String(vendor.api_secret || '').trim(),
    bearerFromVendor,
    sandbox,
    tokenInfo,
    timeoutMs: Number(env('SUREPASS_TIMEOUT_MS', '60000')) || 60000,
    vendorKey: key,
    isExperian,
  };
}

export function surepassConfigured(vendor = {}) {
  const cfg = getSurepassConfig(vendor);
  return Boolean(cfg.token || cfg.bearerFromVendor || (cfg.idNumber && cfg.password));
}

/** True when server credentials point at the paid production bureau (real scores). */
export function surepassLiveMode() {
  return surepassConfigured() && !getSurepassConfig().sandbox;
}

/** Depth-limited search for the first non-empty value under any of `keys`. */
function findDeep(obj, keys, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (value != null && value !== '' && typeof value !== 'object') return value;
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const found = findDeep(value, keys, depth + 1);
      if (found != null) return found;
    }
  }
  return undefined;
}

export function extractCreditScore(payload) {
  const raw = findDeep(payload, [
    'credit_score',
    'cibil_score',
    'cibilScore',
    'experian_score',
    'experianScore',
    'creditScore',
    'score',
    'Score',
    'CREDIT_SCORE',
    'BureauScore',
  ]);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 300 || n > 900) return null;
  return Math.round(n);
}

function extractPdfPayload(payload) {
  return {
    url: findDeep(payload, [
      'credit_report_link',
      'report_link',
      'pdf_link',
      'pdf_url',
      'pdfUrl',
      'report_url',
      'reportUrl',
      'download_url',
      'file_url',
    ]),
    base64: findDeep(payload, ['pdf_base64', 'pdfBase64', 'report_pdf', 'pdf']),
    clientId: findDeep(payload, ['client_id', 'clientId', 'request_id', 'requestId']),
  };
}

function formatGender(value) {
  const g = String(value || '').trim().toLowerCase();
  if (g.startsWith('f')) return 'female';
  return 'male';
}

function formatMobile(value) {
  return String(value || '').replace(/\D/g, '').slice(-10);
}

/** Request body documented by Surepass for the bureau PDF endpoints. */
export function buildSurepassCibilBody({ name, pan, mobile, gender, consent = true }, vendor = {}) {
  const body = {
    name: String(name || '').trim(),
    mobile: formatMobile(mobile),
    pan: String(pan || '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
    consent: consent ? 'Y' : 'N',
  };
  if (bureauKey(vendor) === 'transunion_cibil') body.gender = formatGender(gender);
  return body;
}

async function parseResponse(res) {
  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/pdf')) {
    return { pdfBuffer: Buffer.from(await res.arrayBuffer()), json: null };
  }
  const text = await res.text();
  try {
    return { pdfBuffer: null, json: JSON.parse(text) };
  } catch {
    return { pdfBuffer: null, json: { raw: text.slice(0, 500) } };
  }
}

async function loginForToken(cfg) {
  if (cachedToken && Date.now() < cachedTokenExpiresAt) return cachedToken;
  if (!cfg.idNumber || !cfg.password) return cfg.token || cfg.bearerFromVendor || '';

  const res = await fetchWithTimeout(
    `${cfg.baseUrl}/api/v1/login`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ id_number: cfg.idNumber, password: cfg.password }),
      timeoutMessage: 'Surepass login timed out',
    },
    cfg.timeoutMs,
  );
  const { json } = await parseResponse(res);
  const token = findDeep(json, ['token', 'access_token', 'accessToken']);
  if (!res.ok || !token) {
    const err = new Error(String(findDeep(json, ['message', 'error', 'msg']) || `Surepass login failed (${res.status})`));
    err.status = res.status >= 400 ? res.status : 502;
    throw err;
  }
  cachedToken = token;
  cachedTokenExpiresAt = Date.now() + 50 * 60 * 1000;
  return token;
}

/** Download the bureau PDF; signed links reject an extra Authorization header, so try without first. */
async function downloadPdf(url, token, timeoutMs) {
  const attempts = [{}, token ? { Authorization: `Bearer ${token}` } : null].filter(Boolean);
  for (const headers of attempts) {
    try {
      const res = await fetchWithTimeout(
        url,
        { method: 'GET', headers, timeoutMessage: 'Credit report PDF download timed out' },
        timeoutMs,
      );
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (isPdfBuffer(buf)) return buf;
    } catch (err) {
      console.warn('[surepass] PDF download failed:', err?.message || err);
    }
  }
  return null;
}

function decodeBase64Pdf(value) {
  if (!value || typeof value !== 'string') return null;
  const cleaned = value.replace(/^data:application\/pdf;base64,/i, '').replace(/\s/g, '');
  if (cleaned.length < 80) return null;
  try {
    const buf = Buffer.from(cleaned, 'base64');
    return isPdfBuffer(buf) ? buf : null;
  } catch {
    return null;
  }
}

async function postBureau(cfg, token, body, path) {
  const res = await fetchWithTimeout(
    `${cfg.baseUrl}${path}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, application/pdf',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      timeoutMessage: 'Credit bureau request timed out',
    },
    cfg.timeoutMs,
  );
  const parsed = await parseResponse(res);
  return { res, ...parsed, path };
}

function bureauLabel(cfg) {
  return cfg.isExperian ? 'Experian' : 'TransUnion CIBIL';
}

function friendlyProviderError(cfg, status, providerMessage) {
  const label = bureauLabel(cfg);
  if (status === 401 || status === 403) {
    // Short, actionable text (long provider messages were hidden behind a generic error in the UI).
    if (/expired/i.test(providerMessage)) {
      return `${label}: the Surepass API token has expired. Save a valid production token in Admin → API Configuration.`;
    }
    if (/signature|being used in/i.test(providerMessage)) {
      return `${label}: Surepass did not accept the API token on ${cfg.sandbox ? 'sandbox' : 'production'}. Check the token in Admin → API Configuration.`;
    }
    return `${label}: Surepass rejected the API token (${status}). Check the token in Admin → API Configuration.`;
  }
  if (status === 402) return `${label} service is not available: the credit bureau account has insufficient balance.`;
  if (status === 404) return `${label} service endpoint was not found on the bureau gateway.`;
  if (status === 422 || status === 400) {
    return providerMessage
      ? `${label} could not fetch the report: ${providerMessage}`
      : `${label} could not fetch the report. Check the name, PAN and mobile number.`;
  }
  return providerMessage || `${label} request failed (${status || 502})`;
}

export async function requestSurepassCibilPdf(demographics, vendor = {}) {
  const baseCfg = getSurepassConfig(vendor);
  if (!surepassConfigured(vendor)) {
    return {
      ok: false,
      reason: 'surepass_not_configured',
      errorMessage: 'Credit bureau credentials missing. Set SUREPASS_TOKEN on the server.',
    };
  }

  const body = buildSurepassCibilBody(demographics, vendor);
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(body.pan)) {
    return { ok: false, reason: 'invalid_pan', errorMessage: 'A valid PAN is required for the credit report' };
  }
  if (!/^[6-9]\d{9}$/.test(body.mobile)) {
    return { ok: false, reason: 'invalid_mobile', errorMessage: 'A valid 10-digit mobile is required for the credit report' };
  }
  if (!body.name) {
    return { ok: false, reason: 'invalid_name', errorMessage: 'Full name is required for the credit report' };
  }

  let last = null;
  let cfg = baseCfg;
  try {
    const token = await loginForToken(cfg);
    const attempt = async () => {
      for (const path of cfg.paths) {
        last = await postBureau(cfg, token, body, path);
        if (last.res.status !== 404) break;
      }
    };
    await attempt();

    // Valid token sent to the wrong host → Surepass says which host it belongs to. Switch
    // once, remember it for this token, and retry (no report is produced by the 401 call).
    const firstMessage = String(findDeep(last?.json || {}, ['message', 'error', 'msg']) || '');
    const knownHost = [PRODUCTION_BASE_URL, SANDBOX_BASE_URL].includes(cfg.baseUrl);
    if (knownHost && isWrongHostError(last?.res?.status, firstMessage)) {
      const environment = cfg.baseUrl === SANDBOX_BASE_URL ? 'production' : 'sandbox';
      learnedEnvironment.set(tokenFingerprint(token), environment);
      cfg = {
        ...cfg,
        baseUrl: environment === 'production' ? PRODUCTION_BASE_URL : SANDBOX_BASE_URL,
        sandbox: environment === 'sandbox',
      };
      console.warn(`[surepass] token belongs to the ${environment} host — retrying there`);
      await attempt();
    }

    const json = last?.json || {};
    const successFlag = json.success !== false && Number(json.status_code || 200) < 400;
    if (!last?.res?.ok || !successFlag) {
      const status = last?.res?.status;
      const providerMessage = String(findDeep(json, ['message', 'error', 'msg']) || '').slice(0, 240);
      return {
        ok: false,
        reason: 'surepass_error',
        errorMessage: friendlyProviderError(cfg, status, providerMessage),
        response: { httpStatus: status, path: last?.path, baseUrl: cfg.baseUrl, message: providerMessage },
        httpStatus: status,
      };
    }

    const score = extractCreditScore(json);
    const pdfMeta = extractPdfPayload(json);
    let pdfBuffer = last.pdfBuffer && isPdfBuffer(last.pdfBuffer) ? last.pdfBuffer : decodeBase64Pdf(pdfMeta.base64);
    if (!pdfBuffer && pdfMeta.url && /^https?:\/\//i.test(String(pdfMeta.url))) {
      pdfBuffer = await downloadPdf(String(pdfMeta.url), token, cfg.timeoutMs);
    }

    return {
      ok: true,
      creditScore: score,
      pdfBuffer,
      pdfUrl: pdfMeta.url || null,
      clientId: pdfMeta.clientId || null,
      response: json,
      path: last.path,
      sandbox: cfg.sandbox,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'surepass_unreachable',
      errorMessage: `${bureauLabel(cfg)} service could not be reached: ${err?.message || 'network error'}`,
      response: { path: last?.path, baseUrl: cfg.baseUrl, error: String(err?.message || err) },
    };
  }
}

export async function saveCibilPdfBuffer(pdfBuffer, fileStem) {
  return storeCibilReportPdf(pdfBuffer, fileStem);
}
