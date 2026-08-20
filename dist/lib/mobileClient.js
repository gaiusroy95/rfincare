function isMobileClient(req) {
  const header = req.headers["x-rfincare-client"]?.toString()?.toLowerCase();
  return header === "mobile" || req.query?.client === "mobile";
}
function buildMobileAuthJson(req, { accessJwt, refreshJwt, ...rest }) {
  const body = { accessToken: accessJwt, ...rest };
  if (isMobileClient(req) && refreshJwt) {
    body.refreshToken = refreshJwt;
  }
  return body;
}
export {
  buildMobileAuthJson,
  isMobileClient
};
