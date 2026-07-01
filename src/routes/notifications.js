import { Router } from 'express';
import { z } from 'zod';

import { getPool } from '../db/pool.js';
import { newId } from '../lib/ids.js';
import { authenticate } from '../middleware/authenticate.js';
import { ensurePushNotificationSchema } from '../db/ensurePushNotificationSchema.js';
import {
  getUserNotificationPreferences,
  registerPushToken,
  saveUserNotificationPreferences,
  sendExpoPushToUser,
  unregisterPushToken,
} from '../lib/expoPushService.js';

export const notificationsRouter = Router();

function formatNotification(row) {
  return {
    id: row.id,
    customer_id: row.customer_id,
    customerId: row.customer_id,
    title: row.title,
    message: row.message,
    is_read: !!row.is_read,
    isRead: !!row.is_read,
    created_at: row.created_at,
    createdAt: row.created_at,
  };
}

function formatStaffNotification(row) {
  return {
    id: row.id,
    userId: row.user_id,
    role: row.role,
    applicationId: row.application_id,
    eventType: row.event_type,
    title: row.title,
    message: row.message,
    isRead: !!row.is_read,
    is_read: !!row.is_read,
    createdAt: row.created_at,
    created_at: row.created_at,
  };
}

notificationsRouter.get('/me', authenticate, async (req, res, next) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT id, customer_id, title, message, is_read, created_at
       FROM customer_notifications
       WHERE customer_id = :customerId
       ORDER BY created_at DESC
       LIMIT 100`,
      { customerId: req.auth.userId },
    );
    res.json(rows.map(formatNotification));
  } catch (err) {
    next(err);
  }
});

notificationsRouter.get('/staff/me', authenticate, async (req, res, next) => {
  try {
    if (!['agent', 'employee', 'admin', 'super_admin'].includes(req.auth.role)) {
      return res.status(403).json({ error: 'Staff access only' });
    }
    await ensurePushNotificationSchema();
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT id, user_id, role, application_id, event_type, title, message, is_read, created_at
       FROM staff_notifications
       WHERE user_id = :uid
       ORDER BY created_at DESC
       LIMIT 100`,
      { uid: req.auth.userId },
    );
    res.json(rows.map(formatStaffNotification));
  } catch (err) {
    next(err);
  }
});

notificationsRouter.get('/customers/:customerId', authenticate, async (req, res, next) => {
  try {
    if (
      req.auth.role !== 'admin'
      && req.auth.role !== 'super_admin'
      && req.auth.role !== 'employee'
      && req.params.customerId !== req.auth.userId
    ) {
      const e = new Error('Insufficient permissions');
      e.status = 403;
      throw e;
    }
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT id, customer_id, title, message, is_read, created_at
       FROM customer_notifications
       WHERE customer_id = :customerId
       ORDER BY created_at DESC
       LIMIT 100`,
      { customerId: req.params.customerId },
    );
    res.json(rows.map(formatNotification));
  } catch (err) {
    next(err);
  }
});

notificationsRouter.get('/preferences', authenticate, async (req, res, next) => {
  try {
    const prefs = await getUserNotificationPreferences(req.auth.userId);
    res.json({ preferences: prefs });
  } catch (err) {
    next(err);
  }
});

const PreferencesSchema = z.object({
  push: z.boolean().optional(),
  email: z.boolean().optional(),
  sms: z.boolean().optional(),
  marketing: z.boolean().optional(),
});

notificationsRouter.patch('/preferences', authenticate, async (req, res, next) => {
  try {
    const input = PreferencesSchema.parse(req.body?.preferences ?? req.body);
    const prefs = await saveUserNotificationPreferences(req.auth.userId, input);
    res.json({ preferences: prefs });
  } catch (err) {
    next(err);
  }
});

const PushTokenSchema = z.object({
  expoPushToken: z.string().min(1),
  platform: z.enum(['ios', 'android', 'web']).optional(),
  appVariant: z.enum(['customer', 'agent']).optional(),
});

notificationsRouter.post('/push-tokens', authenticate, async (req, res, next) => {
  try {
    const input = PushTokenSchema.parse(req.body);
    await registerPushToken({
      userId: req.auth.userId,
      role: req.auth.role,
      expoPushToken: input.expoPushToken,
      platform: input.platform || null,
      appVariant: input.appVariant || (req.auth.role === 'agent' ? 'agent' : 'customer'),
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.delete('/push-tokens', authenticate, async (req, res, next) => {
  try {
    const token = req.body?.expoPushToken || req.query?.expoPushToken;
    if (token) await unregisterPushToken(String(token));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.patch('/:id/read', authenticate, async (req, res, next) => {
  try {
    const pool = getPool();
    await pool.execute(
      `UPDATE customer_notifications
       SET is_read = 1
       WHERE id = :id AND customer_id = :customerId`,
      { id: req.params.id, customerId: req.auth.userId },
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.patch('/staff/:id/read', authenticate, async (req, res, next) => {
  try {
    const pool = getPool();
    await pool.execute(
      `UPDATE staff_notifications SET is_read = 1 WHERE id = :id AND user_id = :uid`,
      { id: req.params.id, uid: req.auth.userId },
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.patch('/me/read-all', authenticate, async (req, res, next) => {
  try {
    const pool = getPool();
    await pool.execute(
      `UPDATE customer_notifications SET is_read = 1 WHERE customer_id = :customerId`,
      { customerId: req.auth.userId },
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.patch('/staff/me/read-all', authenticate, async (req, res, next) => {
  try {
    const pool = getPool();
    await pool.execute(
      `UPDATE staff_notifications SET is_read = 1 WHERE user_id = :uid`,
      { uid: req.auth.userId },
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Create notification (internal / timeline hook). */
export async function createCustomerNotification(
  pool,
  { customerId, title, message, type = 'general', data = {} },
) {
  const id = newId();
  await pool.execute(
    `INSERT INTO customer_notifications (id, customer_id, title, message, is_read)
     VALUES (:id, :customer_id, :title, :message, 0)`,
    { id, customer_id: customerId, title, message },
  );

  sendExpoPushToUser(customerId, {
    title,
    body: message,
    data: { type, notificationId: id, ...data },
  }).catch(() => {});

  return id;
}

/** Create staff notification and send push. */
export async function createStaffNotification(
  pool,
  { userId, role, applicationId, eventType, title, message, data = {} },
) {
  const id = newId();
  await pool.execute(
    `INSERT INTO staff_notifications (id, user_id, role, application_id, event_type, title, message)
     VALUES (:id, :uid, :role, :app, :event, :title, :msg)`,
    {
      id,
      uid: userId,
      role,
      app: applicationId || null,
      event: eventType,
      title,
      msg: message,
    },
  );

  sendExpoPushToUser(userId, {
    title,
    body: message,
    data: {
      type: eventType || 'staff_update',
      notificationId: id,
      applicationId: applicationId || null,
      role,
      ...data,
    },
  }).catch(() => {});

  return id;
}
