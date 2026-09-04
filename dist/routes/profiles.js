import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { getPool } from "../db/pool.js";
import { ensurePushNotificationSchema } from "../db/ensurePushNotificationSchema.js";
import { saveUserNotificationPreferences } from "../lib/expoPushService.js";
import { newId } from "../lib/ids.js";
import { generateOtp, hashOtp, sendOtpNotification } from "../lib/otp.js";
import { createUploadMiddleware, spreadUpload } from "../lib/multerUpload.js";
import { toStoredPath } from "../lib/storage/keys.js";
const profilesRouter = Router();
const UpdateMeSchema = z.object({
  full_name: z.string().min(1).optional(),
  phone: z.string().min(6).optional(),
  avatar_url: z.string().url().optional().or(z.literal("")),
  notification_preferences: z.object({
    push: z.boolean().optional(),
    email: z.boolean().optional(),
    sms: z.boolean().optional(),
    marketing: z.boolean().optional()
  }).optional(),
  notificationPreferences: z.object({
    push: z.boolean().optional(),
    email: z.boolean().optional(),
    sms: z.boolean().optional(),
    marketing: z.boolean().optional()
  }).optional()
}).passthrough();
const avatarUpload = createUploadMiddleware({
  subfolder: "avatars",
  maxBytes: 5 * 1024 * 1024,
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp)$/i.test(file.mimetype || "");
    cb(ok ? null : new Error("Photo must be JPG, PNG, or WEBP"), ok);
  }
});
profilesRouter.patch(
  "/me",
  authenticate,
  authorize({ resource: "profile", action: "update", getOwnerId: (req) => req.auth.userId }),
  async (req, res, next) => {
    try {
      const input = UpdateMeSchema.parse(req.body);
      const pool = getPool();
      if (input.notification_preferences || input.notificationPreferences) {
        await ensurePushNotificationSchema();
        await saveUserNotificationPreferences(
          req.auth.userId,
          input.notification_preferences || input.notificationPreferences
        );
      }
      const avatarUrl = Object.prototype.hasOwnProperty.call(input, "avatar_url") ? input.avatar_url : void 0;
      const clearAvatar = avatarUrl === "";
      await pool.execute(
        `UPDATE user_profiles
         SET full_name = COALESCE(:full_name, full_name),
             phone = COALESCE(:phone, phone),
             avatar_url = CASE
               WHEN CAST(:clear_avatar AS TEXT) IN ('1', 'true', 't') THEN NULL
               WHEN :avatar_url IS NOT NULL AND CAST(:avatar_url AS TEXT) <> '' THEN :avatar_url
               ELSE avatar_url
             END
         WHERE id = :id`,
        {
          full_name: input.full_name ?? null,
          phone: input.phone ?? null,
          avatar_url: avatarUrl || null,
          clear_avatar: clearAvatar ? 1 : 0,
          id: req.auth.userId
        }
      );
      const [[profile]] = await pool.execute(`SELECT * FROM user_profiles WHERE id = :id LIMIT 1`, {
        id: req.auth.userId
      });
      res.json({ profile });
    } catch (err) {
      next(err);
    }
  }
);
profilesRouter.post(
  "/me/avatar",
  authenticate,
  authorize({ resource: "profile", action: "update", getOwnerId: (req) => req.auth.userId }),
  ...spreadUpload(avatarUpload, "single", "file"),
  async (req, res, next) => {
    try {
      const file = req.file;
      if (!file) {
        const e = new Error("Choose a photo to upload");
        e.status = 400;
        throw e;
      }
      const stored = toStoredPath(file.filename || file.key || file.path) || (file.filename ? `/uploads/${file.filename}` : null);
      if (!stored) {
        const e = new Error("Could not store photo");
        e.status = 500;
        throw e;
      }
      const pool = getPool();
      await pool.execute(`UPDATE user_profiles SET avatar_url = :url WHERE id = :id`, {
        url: stored,
        id: req.auth.userId
      });
      const [[profile]] = await pool.execute(`SELECT * FROM user_profiles WHERE id = :id LIMIT 1`, {
        id: req.auth.userId
      });
      res.json({ profile, avatarUrl: stored });
    } catch (err) {
      next(err);
    }
  }
);
const EmailChangeRequestSchema = z.object({
  email: z.string().email()
});
const EmailChangeConfirmSchema = z.object({
  email: z.string().email(),
  otp: z.string().length(6)
});
profilesRouter.post(
  "/me/email/request-otp",
  authenticate,
  authorize({ resource: "profile", action: "update", getOwnerId: (req) => req.auth.userId }),
  async (req, res, next) => {
    try {
      const { email } = EmailChangeRequestSchema.parse(req.body);
      const nextEmail = email.toLowerCase().trim();
      const pool = getPool();
      const [[existing]] = await pool.execute(
        `SELECT id FROM user_profiles WHERE LOWER(email) = :email AND id <> :id LIMIT 1`,
        { email: nextEmail, id: req.auth.userId }
      );
      if (existing) {
        return res.status(409).json({ error: "This email is already registered to another account" });
      }
      const otp = generateOtp();
      await pool.execute(
        `INSERT INTO lead_otps (id, lead_id, email, phone, otp_hash, purpose, channel, expires_at)
         VALUES (:id, NULL, :email, NULL, :hash, 'email_change', 'email', NOW() + INTERVAL '10 minutes')`,
        {
          id: newId(),
          email: nextEmail,
          hash: hashOtp(otp)
        }
      );
      await sendOtpNotification({
        email: nextEmail,
        otp,
        purpose: "email_change"
      });
      res.json({
        ok: true,
        message: "OTP sent to the new email address",
        ...process.env.LOG_OTP === "true" ? { devOtp: otp } : {}
      });
    } catch (err) {
      next(err);
    }
  }
);
profilesRouter.post(
  "/me/email/confirm",
  authenticate,
  authorize({ resource: "profile", action: "update", getOwnerId: (req) => req.auth.userId }),
  async (req, res, next) => {
    try {
      const input = EmailChangeConfirmSchema.parse(req.body);
      const nextEmail = input.email.toLowerCase().trim();
      const pool = getPool();
      const [[otpRow]] = await pool.execute(
        `SELECT id FROM lead_otps
         WHERE email = :email AND otp_hash = :hash
           AND purpose = 'email_change' AND verified_at IS NULL
           AND expires_at > NOW()
         ORDER BY created_at DESC
         LIMIT 1`,
        { email: nextEmail, hash: hashOtp(input.otp) }
      );
      if (!otpRow) {
        return res.status(400).json({ error: "Invalid or expired OTP" });
      }
      const [[taken]] = await pool.execute(
        `SELECT id FROM user_profiles WHERE LOWER(email) = :email AND id <> :id LIMIT 1`,
        { email: nextEmail, id: req.auth.userId }
      );
      if (taken) {
        return res.status(409).json({ error: "This email is already registered to another account" });
      }
      await pool.execute(`UPDATE lead_otps SET verified_at = NOW() WHERE id = :id`, { id: otpRow.id });
      await pool.execute(
        `UPDATE user_profiles SET email = :email WHERE id = :id`,
        { email: nextEmail, id: req.auth.userId }
      );
      try {
        await pool.execute(
          `UPDATE users SET email = :email WHERE id = :id`,
          { email: nextEmail, id: req.auth.userId }
        );
      } catch {
      }
      const [[profile]] = await pool.execute(`SELECT * FROM user_profiles WHERE id = :id LIMIT 1`, {
        id: req.auth.userId
      });
      res.json({ profile, message: "Email updated successfully" });
    } catch (err) {
      next(err);
    }
  }
);
export {
  profilesRouter
};
