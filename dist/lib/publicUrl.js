let cachedCallbacks = null;
let cacheAt = 0;
const CACHE_MS = 3e4;
async function loadCallbackUrls() {
  if (cachedCallbacks && Date.now() - cacheAt < CACHE_MS) {
    return cachedCallbacks;
  }
  try {
    const { getOAuthGlobalSettings } = await import("./oauthProviderSettings.js");
    const global = await getOAuthGlobalSettings();
    cachedCallbacks = global.frontendCallbackUrls?.length ? global.frontendCallbackUrls : null;
    cacheAt = Date.now();
    return cachedCallbacks;
  } catch {
    return null;
  }
}
function getPublicSiteOrigin() {
  if (process.env.API_PUBLIC_URL) {
    return process.env.API_PUBLIC_URL.replace(/\/$/, "");
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return `http://127.0.0.1:${process.env.API_PORT || 8080}`;
}
const MOBILE_OAUTH_CALLBACK = "rfincare://oauth/callback";
function parseCallbackListFromEnv() {
  const raw = process.env.OAUTH_FRONTEND_CALLBACK || "";
  const urls = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const withMobile = [...urls];
  if (!withMobile.includes(MOBILE_OAUTH_CALLBACK)) {
    withMobile.push(MOBILE_OAUTH_CALLBACK);
  }
  if (withMobile.length > 1 || urls.length) return withMobile;
  if (process.env.VERCEL_URL) {
    return [`${getPublicSiteOrigin()}/oauth/callback`, MOBILE_OAUTH_CALLBACK];
  }
  return ["http://127.0.0.1:4028/oauth/callback", MOBILE_OAUTH_CALLBACK];
}
function getOAuthFrontendCallbackUrls() {
  return parseCallbackListFromEnv();
}
async function getOAuthFrontendCallbackUrlsAsync() {
  const fromDb = await loadCallbackUrls();
  if (fromDb?.length) return fromDb;
  return parseCallbackListFromEnv();
}
function getOAuthFrontendCallback() {
  return getOAuthFrontendCallbackUrls()[0];
}
function originOfCallbackUrl(callbackUrl) {
  try {
    return new URL(callbackUrl).origin;
  } catch {
    return null;
  }
}
function resolveOAuthFrontendCallback(returnOrigin, urls = getOAuthFrontendCallbackUrls()) {
  if (!returnOrigin) return urls[0];
  const normalized = returnOrigin.replace(/\/$/, "");
  const exact = urls.find((url) => url.replace(/\/$/, "") === normalized);
  if (exact) return exact;
  const mobileMatch = urls.find((url) => url.startsWith("rfincare://") && normalized.startsWith("rfincare://"));
  if (mobileMatch) return mobileMatch;
  const match = urls.find((url) => originOfCallbackUrl(url) === normalized);
  return match || urls[0];
}
async function resolveOAuthFrontendCallbackAsync(returnOrigin) {
  const urls = await getOAuthFrontendCallbackUrlsAsync();
  return resolveOAuthFrontendCallback(returnOrigin, urls);
}
function isAllowedOAuthFrontendCallback(callbackUrl, urls = getOAuthFrontendCallbackUrls()) {
  return urls.some((u) => u === callbackUrl);
}
async function isAllowedOAuthFrontendCallbackAsync(callbackUrl) {
  const urls = await getOAuthFrontendCallbackUrlsAsync();
  return isAllowedOAuthFrontendCallback(callbackUrl, urls);
}
export {
  getOAuthFrontendCallback,
  getOAuthFrontendCallbackUrls,
  getOAuthFrontendCallbackUrlsAsync,
  getPublicSiteOrigin,
  isAllowedOAuthFrontendCallback,
  isAllowedOAuthFrontendCallbackAsync,
  resolveOAuthFrontendCallback,
  resolveOAuthFrontendCallbackAsync
};
