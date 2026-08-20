function useCrossSiteCookies() {
  return process.env.API_COOKIE_CROSS_SITE === "true" || process.env.API_COOKIE_SECURE === "true" || Boolean(process.env.VERCEL);
}
function getSecureCookie() {
  return process.env.API_COOKIE_SECURE === "true" || Boolean(process.env.VERCEL);
}
function getSessionCookieOptions(path, maxAgeMs) {
  const crossSite = useCrossSiteCookies();
  return {
    httpOnly: true,
    secure: getSecureCookie(),
    sameSite: crossSite ? "none" : "lax",
    path,
    maxAge: maxAgeMs
  };
}
export {
  getSecureCookie,
  getSessionCookieOptions,
  useCrossSiteCookies
};
