/**
 * Allocate human-readable agent application IDs: RF-AG-{YYYY}-{NNNNNN}
 */

function currentYearLabel(date = new Date()) {
  return String((date instanceof Date ? date : new Date(date)).getFullYear());
}

export function formatApplicationId(yearLabel, sequenceNumber) {
  const year = String(yearLabel || currentYearLabel()).trim();
  const n = Math.max(1, Number(sequenceNumber) || 1);
  return `RF-AG-${year}-${String(n).padStart(6, '0')}`;
}

async function nextSeqFromMax(pool, yearLabel) {
  const prefix = `RF-AG-${yearLabel}-`;
  const [[row]] = await pool.execute(
    `SELECT COALESCE(MAX(CAST(RIGHT(application_id, 6) AS INTEGER)), 0) AS max_seq
     FROM agent_applications
     WHERE application_id LIKE :prefix`,
    { prefix: `${prefix}%` },
  );
  return Number(row?.max_seq || 0) + 1;
}

async function bumpCounter(pool, yearLabel, seq) {
  try {
    await pool.execute(
      `INSERT INTO agent_application_id_counters (year_label, last_seq)
       VALUES (:year, :seq)
       ON CONFLICT (year_label) DO UPDATE
         SET last_seq = GREATEST(agent_application_id_counters.last_seq, EXCLUDED.last_seq),
             updated_at = NOW()`,
      { year: yearLabel, seq },
    );
  } catch {
    // counter is best-effort; uniqueness is enforced by application_id UNIQUE
  }
}

/**
 * Reserve the next RF-AG-{year}-{6 digit} application id (MAX+1 for year, with counter sync).
 */
export async function allocateApplicationId(pool) {
  const yearLabel = currentYearLabel();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const seq = (await nextSeqFromMax(pool, yearLabel)) + attempt;
    const applicationId = formatApplicationId(yearLabel, seq);
    const [[existing]] = await pool.execute(
      `SELECT id FROM agent_applications WHERE application_id = :aid LIMIT 1`,
      { aid: applicationId },
    );
    if (!existing) {
      await bumpCounter(pool, yearLabel, seq);
      return applicationId;
    }
  }
  throw new Error('Could not allocate unique agent application id');
}
