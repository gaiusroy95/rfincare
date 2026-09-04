import express, { Router } from "express";
import {
  completeInsurancePurchasePush,
  markInsuranceOrderPaid
} from "../lib/insurancePurchaseService.js";
import { verifyRazorpayWebhookSignature } from "../lib/razorpayClient.js";
const paymentsRouter = Router();
paymentsRouter.post(
  "/razorpay/webhook",
  express.raw({ type: "application/json" }),
  async (req, res, next) => {
    try {
      const signature = req.headers["x-razorpay-signature"];
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
      if (!await verifyRazorpayWebhookSignature(rawBody, signature)) {
        return res.status(401).json({ error: "Invalid webhook signature" });
      }
      const payload = JSON.parse(rawBody.toString("utf8") || "{}");
      const event = payload?.event || "";
      const entity = payload?.payload?.payment?.entity || payload?.payload?.order?.entity || {};
      const razorpayOrderId = entity.order_id || entity.id || payload?.payload?.order?.entity?.id;
      const razorpayPaymentId = payload?.payload?.payment?.entity?.id || null;
      if (["payment.captured", "order.paid", "payment.authorized"].includes(event) && razorpayOrderId) {
        const order = await markInsuranceOrderPaid({
          razorpayOrderId,
          razorpayPaymentId,
          razorpaySignature: String(signature || ""),
          eventPayload: payload
        });
        if (order) {
          try {
            await completeInsurancePurchasePush(order.id);
          } catch {
          }
        }
      }
      res.json({ received: true });
    } catch (err) {
      next(err);
    }
  }
);
export {
  paymentsRouter
};
