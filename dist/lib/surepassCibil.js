import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fetchWithTimeout } from "./fetchWithTimeout.js";
import { getUploadDir } from "./uploadPaths.js";
const DEFAULT_BASE_URL = "https://kyc-api.surepass.io";
const DEFAULT_CIBIL_PATH = "/api/v1/credit-cibil-pdf-report";
const FALLBACK_PATHS = [
  "/api/v1/credit-cibil-pdf-report",
  "/api/v1/credit-report-cibil",
  "/api/v1/credit-report-cibil/pdf"
];
let cachedToken = null;
let cachedTokenExpiresAt = 0;
function env(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}
function getSurepassConfig(vendor = {}) {
  const baseUrl = env("SUREPASS_BASE_URL", DEFAULT_BASE_URL).replace(/\/$/, "");
  const path = env("SUREPASS_CIBIL_PATH", DEFAULT_CIBIL_PATH);
  const token = env("SUREPASS_TOKEN");
  const idNumber = env("SUREPASS_ID_NUMBER");
  const password = env("SUREPASS_PASSWORD") || String(vendor.api_secret || "").trim();
  const sandbox = env("SUREPASS_SANDBOX", "true") !== "false";
  const timeoutMs = Number(env("SUREPASS_TIMEOUT_MS", "25000")) || 25e3;
  return {
    baseUrl,
    path: path.startsWith("/") ? path : `/${path}`,
    token,
    idNumber,
    password,
    bearerFromVendor: String(vendor.api_key || "").trim(),
    sandbox,
    timeoutMs
  };
}
function surepassConfigured(vendor = {}) {
  const cfg = getSurepassConfig(vendor);
  return Boolean(cfg.token || cfg.bearerFromVendor || cfg.idNumber && cfg.password);
}
function pick(obj, keys) {
  if (!obj || typeof obj !== "object") return void 0;
  for (const key of keys) {
    const value = obj[key];
    if (value != null && value !== "") return value;
  }
  return void 0;
}
function walk(obj, keys) {
  const direct = pick(obj, keys);
  if (direct != null) return direct;
  if (!obj || typeof obj !== "object") return void 0;
  for (const nested of [obj.data, obj.result, obj.payload, obj.credit_report, obj.creditReport]) {
    const found = pick(nested, keys);
    if (found != null) return found;
  }
  return void 0;
}
function extractCreditScore(payload) {
  const raw = walk(payload, [
    "credit_score",
    "cibil_score",
    "cibilScore",
    "creditScore",
    "score",
    "Score",
    "CREDIT_SCORE"
  ]);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 300 || n > 900) return null;
  return Math.round(n);
}
function extractPdfPayload(payload) {
  return {
    url: walk(payload, ["pdf_url", "pdfUrl", "report_url", "reportUrl", "download_url", "file_url"]),
    base64: walk(payload, ["pdf_base64", "pdfBase64", "base64", "pdf", "report_pdf"]),
    clientId: walk(payload, ["client_id", "clientId", "request_id", "requestId"])
  };
}
function formatDob(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}-${iso[2]}-${iso[1]}`;
  return raw;
}
function formatGender(value) {
  const g = String(value || "").trim().toLowerCase();
  if (g.startsWith("m")) return "male";
  if (g.startsWith("f")) return "female";
  return g || "male";
}
function formatMobile(value) {
  return String(value || "").replace(/\D/g, "").slice(-10);
}
function buildSurepassCibilBody({ name, pan, mobile, dob, gender, fatherName, pincode, consent = true }) {
  const panNumber = String(pan || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const mobileNo = formatMobile(mobile);
  const fullName = String(name || "").trim();
  const dateOfBirth = formatDob(dob);
  const genderValue = formatGender(gender);
  const father = String(fatherName || "").trim();
  const pin = String(pincode || "").replace(/\D/g, "").slice(0, 6);
  return {
    name: fullName,
    full_name: fullName,
    father_name: father || void 0,
    pan: panNumber,
    pan_number: panNumber,
    id_number: panNumber,
    mobile: mobileNo,
    mobile_no: mobileNo,
    mobile_number: mobileNo,
    dob: dateOfBirth,
    date_of_birth: dateOfBirth,
    gender: genderValue,
    pincode: pin || void 0,
    pin_code: pin || void 0,
    consent: consent ? "Y" : "N",
    consent_text: "I hereby authorize Rfincare and its bureau partner to fetch my credit information."
  };
}
async function parseResponse(res) {
  const contentType = String(res.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/pdf")) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { pdfBuffer: buf, json: null };
  }
  const text = await res.text();
  try {
    return { pdfBuffer: null, json: JSON.parse(text) };
  } catch {
    return { pdfBuffer: null, json: { raw: text.slice(0, 2e3) } };
  }
}
async function loginForToken(cfg) {
  if (cachedToken && Date.now() < cachedTokenExpiresAt) return cachedToken;
  if (!cfg.idNumber || !cfg.password) return cfg.token || cfg.bearerFromVendor || "";
  const res = await fetchWithTimeout(
    `${cfg.baseUrl}/api/v1/login`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ id_number: cfg.idNumber, password: cfg.password }),
      timeoutMessage: "Surepass login timed out"
    },
    cfg.timeoutMs
  );
  const { json } = await parseResponse(res);
  const token = walk(json, ["token", "access_token", "accessToken"]);
  if (!res.ok || !token) {
    const message = walk(json, ["message", "error", "msg"]) || `Surepass login failed (${res.status})`;
    const err = new Error(String(message));
    err.status = res.status >= 400 ? res.status : 502;
    throw err;
  }
  cachedToken = token;
  cachedTokenExpiresAt = Date.now() + 50 * 60 * 1e3;
  return token;
}
async function downloadPdf(url, token, timeoutMs) {
  const res = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      timeoutMessage: "Surepass PDF download timed out"
    },
    timeoutMs
  );
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length > 100 ? buf : null;
}
function decodeBase64Pdf(value) {
  if (!value || typeof value !== "string") return null;
  const cleaned = value.replace(/^data:application\/pdf;base64,/i, "").replace(/\s/g, "");
  if (cleaned.length < 80) return null;
  try {
    const buf = Buffer.from(cleaned, "base64");
    return buf.length > 100 ? buf : null;
  } catch {
    return null;
  }
}
async function postCibil(cfg, token, body, path) {
  const res = await fetchWithTimeout(
    `${cfg.baseUrl}${path}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, application/pdf",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(body),
      timeoutMessage: "Surepass CIBIL request timed out"
    },
    cfg.timeoutMs
  );
  const parsed = await parseResponse(res);
  return { res, ...parsed, path };
}
async function requestSurepassCibilPdf(demographics, vendor = {}) {
  const cfg = getSurepassConfig(vendor);
  if (!surepassConfigured(vendor)) {
    return {
      ok: false,
      reason: "surepass_not_configured",
      errorMessage: "Surepass credentials missing. Set SUREPASS_TOKEN or SUREPASS_ID_NUMBER + SUREPASS_PASSWORD in backend/.env"
    };
  }
  const body = buildSurepassCibilBody(demographics);
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(body.pan)) {
    return { ok: false, reason: "invalid_pan", errorMessage: "A valid PAN is required for CIBIL pull" };
  }
  if (!/^[6-9]\d{9}$/.test(body.mobile)) {
    return { ok: false, reason: "invalid_mobile", errorMessage: "A valid 10-digit mobile is required for CIBIL pull" };
  }
  if (!body.name) {
    return { ok: false, reason: "invalid_name", errorMessage: "Full name is required for CIBIL pull" };
  }
  const token = await loginForToken(cfg);
  const paths = [cfg.path, ...FALLBACK_PATHS.filter((p) => p !== cfg.path)];
  let last = null;
  for (const path of paths) {
    const attempt = await postCibil(cfg, token, body, path);
    last = attempt;
    if (attempt.res.status === 404) continue;
    break;
  }
  const json = last?.json || {};
  const successFlag = json.success !== false && json.status_code !== 400;
  if (!last?.res?.ok || !successFlag) {
    return {
      ok: false,
      reason: "surepass_error",
      errorMessage: String(walk(json, ["message", "error", "msg"]) || `Surepass CIBIL failed (${last?.res?.status || 502})`),
      response: json,
      httpStatus: last?.res?.status
    };
  }
  const score = extractCreditScore(json);
  const pdfMeta = extractPdfPayload(json);
  let pdfBuffer = last.pdfBuffer || decodeBase64Pdf(pdfMeta.base64);
  if (!pdfBuffer && pdfMeta.url) {
    pdfBuffer = await downloadPdf(pdfMeta.url, token, cfg.timeoutMs);
  }
  return {
    ok: true,
    creditScore: score,
    pdfBuffer,
    pdfUrl: pdfMeta.url || null,
    clientId: pdfMeta.clientId || null,
    response: json,
    path: last.path,
    sandbox: cfg.sandbox
  };
}
function saveCibilPdfBuffer(pdfBuffer, fileStem) {
  const reportDir = resolve(getUploadDir(), "cibil-reports");
  mkdirSync(reportDir, { recursive: true });
  const fileName = `${fileStem}-${Date.now()}.pdf`;
  writeFileSync(resolve(reportDir, fileName), pdfBuffer);
  return `/uploads/cibil-reports/${fileName}`;
}
export {
  buildSurepassCibilBody,
  extractCreditScore,
  getSurepassConfig,
  requestSurepassCibilPdf,
  saveCibilPdfBuffer,
  surepassConfigured
};
