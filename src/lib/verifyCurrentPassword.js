import bcrypt from 'bcryptjs';
import { getPool } from '../db/pool.js';

export async function verifyCurrentPassword(userId, currentPassword) {
  const pool = getPool();
  const [[user]] = await pool.execute(
    `SELECT password_hash FROM auth_users WHERE id = :id LIMIT 1`,
    { id: userId },
  );

  if (!user?.password_hash) {
    const e = new Error('Account not found');
    e.status = 404;
    throw e;
  }

  const ok = await bcrypt.compare(String(currentPassword || ''), user.password_hash);
  if (!ok) {
    const e = new Error('Current password is incorrect');
    e.status = 401;
    throw e;
  }
}
