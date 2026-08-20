import crypto from "node:crypto";
import axios from "axios";
function requireEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    const err = new Error(`${name} is required for Razorpay integration`);
    err.status = 503;
    throw err;
  }
  return value;
}
function getRazorpayConfig() {
  return {
    keyId: requireEnv("RAZORPAY_KEY_ID"),
    keySecret: requireEnv("RAZORPAY_KEY_SECRET"),
    webhookSecret: String(process.env.RAZORPAY_WEBHOOK_SECRET || "").trim()
  };
}
function getAuthHeader() {
  const { keyId, keySecret } = getRazorpayConfig();
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
}
async function createRazorpayOrder({
  amountPaise,
  currency = "INR",
  receipt,
  notes = {}
}) {
  const res = await axios.post(
    "https://api.razorpay.com/v1/orders",
    {
      amount: amountPaise,
      currency,
      receipt,
      payment_capture: 1,
      notes
    },
    {
      headers: {
        Authorization: getAuthHeader(),
        "Content-Type": "application/json"
      },
      timeout: 3e4
    }
  );
  return res.data;
}
function verifyRazorpayWebhookSignature(rawBody, signature) {
  const webhookSecret = String(process.env.RAZORPAY_WEBHOOK_SECRET || "").trim();
  if (!webhookSecret) return false;
  const digest = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(String(signature || "")));
  } catch {
    return false;
  }
}
export {
  createRazorpayOrder,
  getRazorpayConfig,
  verifyRazorpayWebhookSignature
};
