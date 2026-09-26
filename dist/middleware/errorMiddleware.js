import { ZodError } from "zod";
import { toPublicOtpMessage } from "../lib/otp.js";
const PROVIDER_LEAK_RE = /sender\s*id|msg91|smtp|twilio|auth[_ ]?key|subscription|dlt|badcredentials|535|template_id|cloud\s*run|otp settings|console|rfincri?|delivery may fail|no subscription|app password|gmail smtp|smtp_user|smtp_pass/i;
const DB_LEAK_RE = /foreign key|violates|constraint|refresh_tokens|fk_|relation |duplicate key|syntax error|ECONNREFUSED|postgres|sqlstate/i;
function isAdminDiagnosticPath(req) {
  const url = String(req?.originalUrl || req?.url || "");
  return /\/admin\b|\/cms\b|\/leads\b/i.test(url);
}
function errorMiddleware(err, req, res, _next) {
  let status = Number(err?.status || 500);
  let message = err?.message || "Internal server error";
  if (err instanceof ZodError) {
    status = 400;
    message = err.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
  } else if (err?.code === "LIMIT_FILE_SIZE") {
    status = 413;
    message = "File is too large";
  } else if (err?.name === "MulterError") {
    status = 400;
    message = err.message || "Invalid file upload";
  }
  if (status >= 500) {
    console.error(err);
  }
  if (!isAdminDiagnosticPath(req)) {
    if (PROVIDER_LEAK_RE.test(String(message))) {
      message = toPublicOtpMessage(message);
    } else if (DB_LEAK_RE.test(String(message))) {
      status = status >= 500 ? 409 : status;
      message = "Something went wrong while verifying. Please try again in a moment.";
    }
  }
  res.status(status).json({ error: message });
}
export {
  errorMiddleware
};
