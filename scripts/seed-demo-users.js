/**
 * Seed demo users (auth_users + user_profiles).
 * Idempotent: creates missing users or resets password + role for existing emails.
 *
 * Usage (from backend/):
 *   npm run seed:demo-users
 */
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { getPool } from '../src/db/pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

const DEMO_USERS = [
  {
    email: 'admin@rfincare.com',
    password: 'Admin@2026',
    role: 'super_admin',
    fullName: 'Admin User',
  },
  {
    email: 'employee@rfincare.com',
    password: 'Employee@2026',
    role: 'employee',
    fullName: 'Employee User',
  },
  {
    email: 'agent@rfincare.com',
    password: 'Agent@2026',
    role: 'agent',
    fullName: 'Agent User',
  },
  {
    email: 'customer@rfincare.com',
    password: 'Customer@2026',
    role: 'customer',
    fullName: 'Customer User',
  },
];

async function upsertDemoUser(pool, user) {
  const passwordHash = await bcrypt.hash(user.password, 12);

  const [existing] = await pool.execute(
    'SELECT id FROM auth_users WHERE email = :email LIMIT 1',
    { email: user.email },
  );

  let userId;

  if (existing.length > 0) {
    userId = existing[0].id;
    await pool.execute(
      'UPDATE auth_users SET password_hash = :ph, updated_at = CURRENT_TIMESTAMP WHERE id = :id',
      { ph: passwordHash, id: userId },
    );
    console.log(`  ↻ Updated password: ${user.email}`);
  } else {
    userId = randomUUID();
    await pool.execute(
      'INSERT INTO auth_users (id, email, password_hash) VALUES (:id, :email, :ph)',
      { id: userId, email: user.email, ph: passwordHash },
    );
    console.log(`  ✓ Created auth user: ${user.email}`);
  }

  const [profileRows] = await pool.execute(
    'SELECT id FROM user_profiles WHERE id = :id OR email = :email LIMIT 1',
    { id: userId, email: user.email },
  );

  if (profileRows.length > 0) {
    const profileId = profileRows[0].id;
    if (profileId !== userId) {
      await pool.execute('DELETE FROM user_profiles WHERE id = :id', { id: profileId });
      await pool.execute(
        `INSERT INTO user_profiles (id, email, full_name, role, account_status, is_active, failed_login_attempts, locked_until)
         VALUES (:id, :email, :fullName, :role, 'active', TRUE, 0, NULL)`,
        { id: userId, email: user.email, fullName: user.fullName, role: user.role },
      );
    } else {
      await pool.execute(
        `UPDATE user_profiles SET
           email = :email,
           full_name = :fullName,
           role = :role,
           account_status = 'active',
           is_active = TRUE,
           failed_login_attempts = 0,
           locked_until = NULL,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = :id`,
        { id: userId, email: user.email, fullName: user.fullName, role: user.role },
      );
    }
    console.log(`  ↻ Updated profile (${user.role}): ${user.email}`);
  } else {
    await pool.execute(
      `INSERT INTO user_profiles (id, email, full_name, role, account_status, is_active)
       VALUES (:id, :email, :fullName, :role, 'active', TRUE)`,
      { id: userId, email: user.email, fullName: user.fullName, role: user.role },
    );
    console.log(`  ✓ Created profile (${user.role}): ${user.email}`);
  }

  return user;
}

async function seedDemoUsers() {
  const pool = getPool();

  try {
    console.log('Seeding demo users...\n');

    for (const demoUser of DEMO_USERS) {
      console.log(`→ ${demoUser.role}: ${demoUser.email}`);
      await upsertDemoUser(pool, demoUser);
    }

    console.log('\n✅ Demo users ready.\n');
    console.log('Login credentials:');
    console.log('─'.repeat(50));
    for (const u of DEMO_USERS) {
      console.log(`  ${u.role.padEnd(12)} ${u.email} / ${u.password}`);
    }
    console.log('─'.repeat(50));
    console.log('\nURLs:');
    console.log('  Admin:    /admin-login');
    console.log('  Employee: /employee-login');
    console.log('  Agent:    /agent-login');
    console.log('  Customer: /customer-login');
  } catch (error) {
    console.error('Seed failed:', error);
    process.exit(1);
  } finally {
    if (typeof pool.end === 'function') await pool.end();
  }
}

seedDemoUsers();
