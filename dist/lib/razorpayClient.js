import crypto from "node:crypto";
import axios from "axios";
import { resolveRazorpayCredentials } from "./paymentGatewaySettings.js";
async function requireRazorpayKeys() {
  const creds = await resolveRazorpayCredentials();
  if (!creds.isEnabled) {
    const err = new Error("Payment gateway is disabled in admin settings");
    err.status = 503;
    throw err;
  }
  if (!creds.keyId || !creds.keySecret) {
    const err = new Error(
      "Razorpay is not configured. Set RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET or save keys in Admin → API Configuration."
    );
    err.status = 503;
    throw err;
  }
  return creds;
}
async function getRazorpayConfig() {
  const creds = await requireRazorpayKeys();
  return {
    keyId: creds.keyId,
    keySecret: creds.keySecret,
    webhookSecret: creds.webhookSecret || "",
    mode: creds.mode
  };
}
async function getAuthHeader() {
  const { keyId, keySecret } = await getRazorpayConfig();
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
        Authorization: await getAuthHeader(),
        "Content-Type": "application/json"
      },
      timeout: 3e4
    }
  );
  return res.data;
}
async function verifyRazorpayWebhookSignature(rawBody, signature) {
  const creds = await resolveRazorpayCredentials();
  const webhookSecret = String(creds.webhookSecret || "").trim();
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
