/** Detect React Native / Expo clients that cannot use httpOnly refresh cookies. */
export function isMobileClient(req) {
  const header = req.headers['x-rfincare-client']?.toString()?.toLowerCase();
  return header === 'mobile' || req.query?.client === 'mobile';
}

export function buildMobileAuthJson(req, { accessJwt, refreshJwt, ...rest }) {
  const body = { accessToken: accessJwt, ...rest };
  if (isMobileClient(req) && refreshJwt) {
    body.refreshToken = refreshJwt;
  }
  return body;
}
