function asNumber(value) {
  if (value === null || value === void 0 || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
    }
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [value];
}
function unwrapJson(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function resolveApplicantField(applicant, fieldKey) {
  const key = String(fieldKey || "").trim();
  if (!key) return void 0;
  const map = {
    monthly_income: applicant.monthlyIncome,
    monthlyIncome: applicant.monthlyIncome,
    annual_income: (applicant.monthlyIncome || 0) * 12,
    annualIncome: (applicant.monthlyIncome || 0) * 12,
    loan_amount: applicant.loanAmount,
    loanAmount: applicant.loanAmount,
    credit_score: applicant.creditScore,
    creditScore: applicant.creditScore,
    cibil: applicant.creditScore,
    employment_type: applicant.employmentType,
    employmentType: applicant.employmentType,
    age: applicant.age,
    years_employed: applicant.yearsEmployed,
    yearsEmployed: applicant.yearsEmployed,
    existing_emi: applicant.existingLoans,
    existingLoans: applicant.existingLoans,
    property_value: applicant.collateralValue,
    collateralValue: applicant.collateralValue,
    loan_type: applicant.loanType,
    loanType: applicant.loanType,
    dscr: applicant.dscr
  };
  if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
  if (Object.prototype.hasOwnProperty.call(applicant, key)) return applicant[key];
  const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  return applicant[camel];
}
function evaluateCondition(condition, applicant) {
  const fieldKey = condition.field_key || condition.fieldKey;
  const operator = String(condition.operator || "=").trim().toUpperCase();
  const rawValue = unwrapJson(condition.value_json ?? condition.value);
  const rawTo = unwrapJson(condition.value_to_json ?? condition.valueTo);
  const actual = resolveApplicantField(applicant, fieldKey);
  const actualNum = asNumber(actual);
  const expectedNum = asNumber(rawValue);
  const toNum = asNumber(rawTo);
  let pass = true;
  let reason = "";
  switch (operator) {
    case "=":
    case "EQ":
    case "EQUALS":
      pass = String(actual ?? "").toLowerCase() === String(rawValue ?? "").toLowerCase() || actualNum != null && expectedNum != null && actualNum === expectedNum;
      reason = pass ? "equal" : `${actual} != ${rawValue}`;
      break;
    case "!=":
    case "NE":
    case "NOT_EQUALS":
      pass = String(actual ?? "").toLowerCase() !== String(rawValue ?? "").toLowerCase();
      if (actualNum != null && expectedNum != null) pass = actualNum !== expectedNum;
      reason = pass ? "not equal" : `${actual} == ${rawValue}`;
      break;
    case ">":
    case "GT":
      pass = actualNum != null && expectedNum != null && actualNum > expectedNum;
      reason = pass ? "ok" : `${actual} not > ${rawValue}`;
      break;
    case ">=":
    case "GTE":
      pass = actualNum != null && expectedNum != null && actualNum >= expectedNum;
      reason = pass ? "ok" : `${actual} not >= ${rawValue}`;
      break;
    case "<":
    case "LT":
      pass = actualNum != null && expectedNum != null && actualNum < expectedNum;
      reason = pass ? "ok" : `${actual} not < ${rawValue}`;
      break;
    case "<=":
    case "LTE":
      pass = actualNum != null && expectedNum != null && actualNum <= expectedNum;
      reason = pass ? "ok" : `${actual} not <= ${rawValue}`;
      break;
    case "BETWEEN":
      pass = actualNum != null && expectedNum != null && toNum != null && actualNum >= expectedNum && actualNum <= toNum;
      reason = pass ? "in range" : `${actual} not between ${rawValue} and ${rawTo}`;
      break;
    case "IN": {
      const list = asArray(rawValue).map((v) => String(v).toLowerCase());
      pass = list.includes(String(actual ?? "").toLowerCase());
      reason = pass ? "in set" : `${actual} not in [${list.join(",")}]`;
      break;
    }
    case "NOT_IN": {
      const list = asArray(rawValue).map((v) => String(v).toLowerCase());
      pass = !list.includes(String(actual ?? "").toLowerCase());
      reason = pass ? "not in set" : `${actual} in [${list.join(",")}]`;
      break;
    }
    case "CONTAINS":
      pass = String(actual ?? "").toLowerCase().includes(String(rawValue ?? "").toLowerCase());
      reason = pass ? "contains" : `${actual} missing ${rawValue}`;
      break;
    default:
      pass = true;
      reason = `unknown operator ${operator} — skipped`;
  }
  return {
    fieldKey,
    operator,
    expected: rawValue,
    expectedTo: rawTo,
    actual,
    pass,
    reason,
    evaluated: actual !== void 0 && actual !== null && actual !== ""
  };
}
function evaluateRule(rule, conditions, applicant) {
  const list = (conditions || []).filter((c) => c.rule_id === rule.id || c.ruleId === rule.id);
  if (list.length === 0) {
    return {
      ruleId: rule.id,
      ruleName: rule.rule_name || rule.ruleName,
      ruleDomain: rule.rule_domain || rule.ruleDomain,
      severity: rule.severity || "soft",
      status: "NOT_EVALUATED",
      pass: true,
      conditions: []
    };
  }
  const byGroup = /* @__PURE__ */ new Map();
  for (const c of list) {
    const g = String(c.logic_group || c.logicGroup || "AND").toUpperCase();
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(c);
  }
  const traces = [];
  let overallPass = true;
  for (const [group, conds] of byGroup) {
    const results = conds.map((c) => evaluateCondition(c, applicant));
    traces.push(...results.map((r) => ({ ...r, logicGroup: group })));
    if (group === "OR") {
      const any = results.some((r) => r.pass && r.evaluated);
      const anyEval = results.some((r) => r.evaluated);
      if (anyEval && !any) overallPass = false;
    } else {
      for (const r of results) {
        if (r.evaluated && !r.pass) overallPass = false;
      }
    }
  }
  const anyEvaluated = traces.some((t) => t.evaluated);
  return {
    ruleId: rule.id,
    ruleName: rule.rule_name || rule.ruleName,
    ruleDomain: rule.rule_domain || rule.ruleDomain,
    severity: String(rule.severity || "soft").toLowerCase(),
    status: !anyEvaluated ? "NOT_EVALUATED" : overallPass ? "PASS" : "FAIL",
    pass: overallPass || !anyEvaluated,
    conditions: traces
  };
}
function summarizeDecision(ruleResults, { eligibleMin = 70, conditionalMin = 50, probability = 0 } = {}) {
  const criticalFail = (ruleResults || []).some(
    (r) => r.status === "FAIL" && String(r.severity).toLowerCase() === "critical"
  );
  if (criticalFail) {
    return { decision: "NOT_ELIGIBLE", reason: "Critical rule failed" };
  }
  if (probability >= eligibleMin) {
    return { decision: "ELIGIBLE", reason: "Meets probability and soft rules" };
  }
  if (probability >= conditionalMin) {
    return { decision: "CONDITIONAL", reason: "Borderline probability or soft mismatches" };
  }
  return { decision: "NOT_ELIGIBLE", reason: "Below conditional threshold" };
}
export {
  evaluateCondition,
  evaluateRule,
  resolveApplicantField,
  summarizeDecision
};
