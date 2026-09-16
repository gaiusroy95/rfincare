-- Ensure one employee mapping per hierarchy level (1–4) per agent

DELETE FROM agent_employee_hierarchy a
USING agent_employee_hierarchy b
WHERE a.agent_user_id = b.agent_user_id
  AND a.hierarchy_level = b.hierarchy_level
  AND a.hierarchy_level BETWEEN 1 AND 4
  AND a.id <> b.id
  AND (
    (COALESCE(a.is_primary, FALSE) = FALSE AND COALESCE(b.is_primary, FALSE) = TRUE)
    OR (
      COALESCE(a.is_primary, FALSE) = COALESCE(b.is_primary, FALSE)
      AND a.created_at > b.created_at
    )
    OR (
      COALESCE(a.is_primary, FALSE) = COALESCE(b.is_primary, FALSE)
      AND a.created_at = b.created_at
      AND a.id > b.id
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_hierarchy_level
  ON agent_employee_hierarchy (agent_user_id, hierarchy_level);
