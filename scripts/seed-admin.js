import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { getPool } from '../src/db/pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

async function seedAdmin() {
  const pool = getPool();

  try {
    const adminEmail = 'admin@rfincare.com';
    const adminPass = 'Admin@2026';
    const adminId = randomUUID();
    const hashedPass = await bcrypt.hash(adminPass, 12);

    console.log(`Seeding admin user: ${adminEmail}`);

    const [existing] = await pool.execute(
      'SELECT id FROM auth_users WHERE email = :email',
      { email: adminEmail },
    );

    if (existing.length > 0) {
      console.log('Admin user already exists. Updating password...');
      await pool.execute('UPDATE auth_users SET password_hash = :ph WHERE id = :id', {
        ph: hashedPass,
        id: existing[0].id,
      });

      await pool.execute(
        `UPDATE user_profiles SET
           role = 'super_admin',
           is_active = TRUE,
           account_status = 'active',
           failed_login_attempts = 0,
           locked_until = NULL
         WHERE id = :id`,
        { id: existing[0].id },
      );
    } else {
      await pool.execute(
        'INSERT INTO auth_users (id, email, password_hash) VALUES (:id, :email, :ph)',
        { id: adminId, email: adminEmail, ph: hashedPass },
      );

      await pool.execute(
        "INSERT INTO user_profiles (id, email, full_name, role, account_status, is_active) VALUES (:id, :email, 'System Admin', 'super_admin', 'active', TRUE)",
        { id: adminId, email: adminEmail },
      );
    }

    console.log('Admin user seeded successfully!');
    console.log('Email:', adminEmail);
    console.log('Password:', adminPass);
  } catch (error) {
    console.error('Error seeding admin:', error);
    process.exit(1);
  } finally {
    if (typeof pool.end === 'function') await pool.end();
  }
}

seedAdmin();
