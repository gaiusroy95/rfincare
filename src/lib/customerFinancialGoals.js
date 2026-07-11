import { getPool, isNoSuchTableError } from '../db/pool.js';
import { newId } from './ids.js';

export async function ensureFinancialGoalsSchema(pool = getPool()) {
  try {
    await pool.execute(`SELECT 1 FROM customer_financial_goals LIMIT 1`);
  } catch (err) {
    if (!isNoSuchTableError(err)) throw err;
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS customer_financial_goals (
        id VARCHAR(36) PRIMARY KEY,
        customer_id VARCHAR(36) NOT NULL,
        label VARCHAR(120) NOT NULL,
        target_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
        current_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
        target_date DATE NULL,
        notes TEXT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.execute(`
      CREATE INDEX IF NOT EXISTS idx_customer_financial_goals_customer
        ON customer_financial_goals (customer_id, sort_order ASC, created_at ASC)
    `);
  }
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function mapGoal(row) {
  const target = toNumber(row.target_amount);
  const current = toNumber(row.current_amount);
  return {
    id: row.id,
    label: row.label,
    target,
    current,
    progress: target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0,
    targetDate: row.target_date || null,
    notes: row.notes || '',
    sortOrder: Number(row.sort_order) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listFinancialGoals(customerId) {
  const pool = getPool();
  await ensureFinancialGoalsSchema(pool);
  const [rows] = await pool.execute(
    `SELECT id, customer_id, label, target_amount, current_amount, target_date, notes, sort_order, created_at, updated_at
     FROM customer_financial_goals
     WHERE customer_id = :customer_id
     ORDER BY sort_order ASC, created_at ASC
     LIMIT 50`,
    { customer_id: customerId },
  );
  return rows.map(mapGoal);
}

function normalizeGoalInput(input = {}) {
  const label = String(input.label || input.name || '').trim();
  if (!label) {
    const err = new Error('Goal name is required');
    err.status = 400;
    throw err;
  }
  if (label.length > 120) {
    const err = new Error('Goal name is too long');
    err.status = 400;
    throw err;
  }

  const target = toNumber(input.target ?? input.targetAmount);
  const current = toNumber(input.current ?? input.currentAmount);
  if (target < 0 || current < 0) {
    const err = new Error('Amounts cannot be negative');
    err.status = 400;
    throw err;
  }
  if (target > 1e12 || current > 1e12) {
    const err = new Error('Amount is too large');
    err.status = 400;
    throw err;
  }

  let targetDate = input.targetDate || input.target_date || null;
  if (targetDate) {
    const d = new Date(targetDate);
    if (Number.isNaN(d.getTime())) {
      const err = new Error('Invalid target date');
      err.status = 400;
      throw err;
    }
    targetDate = d.toISOString().slice(0, 10);
  }

  return {
    label,
    target,
    current,
    targetDate,
    notes: String(input.notes || '').trim().slice(0, 1000) || null,
  };
}

export async function createFinancialGoal(customerId, input) {
  const pool = getPool();
  await ensureFinancialGoalsSchema(pool);
  const data = normalizeGoalInput(input);
  const [[countRow]] = await pool.execute(
    `SELECT COUNT(*) AS cnt FROM customer_financial_goals WHERE customer_id = :customer_id`,
    { customer_id: customerId },
  );
  if (Number(countRow?.cnt || 0) >= 20) {
    const err = new Error('You can set up to 20 financial goals');
    err.status = 400;
    throw err;
  }

  const id = newId();
  const sortOrder = Number(countRow?.cnt || 0);
  await pool.execute(
    `INSERT INTO customer_financial_goals
       (id, customer_id, label, target_amount, current_amount, target_date, notes, sort_order)
     VALUES
       (:id, :customer_id, :label, :target_amount, :current_amount, :target_date, :notes, :sort_order)`,
    {
      id,
      customer_id: customerId,
      label: data.label,
      target_amount: data.target,
      current_amount: data.current,
      target_date: data.targetDate,
      notes: data.notes,
      sort_order: sortOrder,
    },
  );

  const [[row]] = await pool.execute(
    `SELECT * FROM customer_financial_goals WHERE id = :id LIMIT 1`,
    { id },
  );
  return mapGoal(row);
}

export async function updateFinancialGoal(customerId, goalId, input) {
  const pool = getPool();
  await ensureFinancialGoalsSchema(pool);
  const [[existing]] = await pool.execute(
    `SELECT * FROM customer_financial_goals WHERE id = :id AND customer_id = :customer_id LIMIT 1`,
    { id: goalId, customer_id: customerId },
  );
  if (!existing) {
    const err = new Error('Goal not found');
    err.status = 404;
    throw err;
  }

  const data = normalizeGoalInput({
    label: input.label ?? existing.label,
    target: input.target ?? input.targetAmount ?? existing.target_amount,
    current: input.current ?? input.currentAmount ?? existing.current_amount,
    targetDate: input.targetDate !== undefined ? input.targetDate : existing.target_date,
    notes: input.notes !== undefined ? input.notes : existing.notes,
  });

  await pool.execute(
    `UPDATE customer_financial_goals
     SET label = :label,
         target_amount = :target_amount,
         current_amount = :current_amount,
         target_date = :target_date,
         notes = :notes,
         updated_at = NOW()
     WHERE id = :id AND customer_id = :customer_id`,
    {
      id: goalId,
      customer_id: customerId,
      label: data.label,
      target_amount: data.target,
      current_amount: data.current,
      target_date: data.targetDate,
      notes: data.notes,
    },
  );

  const [[row]] = await pool.execute(
    `SELECT * FROM customer_financial_goals WHERE id = :id LIMIT 1`,
    { id: goalId },
  );
  return mapGoal(row);
}

export async function deleteFinancialGoal(customerId, goalId) {
  const pool = getPool();
  await ensureFinancialGoalsSchema(pool);
  const [result] = await pool.execute(
    `DELETE FROM customer_financial_goals WHERE id = :id AND customer_id = :customer_id`,
    { id: goalId, customer_id: customerId },
  );
  const affected = result?.affectedRows ?? result?.rowCount ?? 0;
  if (!affected) {
    const err = new Error('Goal not found');
    err.status = 404;
    throw err;
  }
  return { deleted: true, id: goalId };
}
