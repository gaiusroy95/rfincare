import { getPool } from './pool.js';

/**
 * Run `work(tx)` inside a real transaction on ONE dedicated connection.
 *
 * `pool.execute('BEGIN')` is not a transaction with pg's Pool: every call can run on a
 * different connection, so statements are not rolled back together and the connection
 * that received BEGIN is returned to the pool mid-transaction (later queries on it stay
 * invisible until something happens to commit/roll back that connection).
 */
export async function withTransaction(work) {
  const conn = await getPool().getConnection();
  conn.inTransaction = true;
  try {
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      /* connection already broken */
    }
    throw err;
  } finally {
    conn.inTransaction = false;
    conn.release();
  }
}

function isMissingSchemaError(err) {
  return err?.code === '42P01' || err?.code === '42703'; // undefined_table / undefined_column
}

let savepointSeq = 0;

/**
 * Execute a statement that may target a table/column absent on older schemas.
 * Missing-schema errors are ignored. Inside a transaction a SAVEPOINT keeps the
 * transaction usable (otherwise Postgres aborts every following statement).
 * @returns the driver result, or null when ignored.
 */
export async function executeIgnoringMissing(executor, sql, params) {
  if (executor?.inTransaction) {
    savepointSeq = (savepointSeq + 1) % 1_000_000;
    const sp = `sp_opt_${savepointSeq}`;
    await executor.execute(`SAVEPOINT ${sp}`);
    try {
      const result = await executor.execute(sql, params);
      await executor.execute(`RELEASE SAVEPOINT ${sp}`);
      return result;
    } catch (err) {
      await executor.execute(`ROLLBACK TO SAVEPOINT ${sp}`);
      if (isMissingSchemaError(err)) return null;
      throw err;
    }
  }
  try {
    return await executor.execute(sql, params);
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}
