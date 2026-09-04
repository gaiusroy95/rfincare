const MIN_APPLICANT_AGE = 21;
function getApplicantAge(dateOfBirth, now = /* @__PURE__ */ new Date()) {
  if (!dateOfBirth) return null;
  const dob = dateOfBirth instanceof Date ? dateOfBirth : new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return null;
  const today = now instanceof Date ? now : new Date(now);
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || m === 0 && today.getDate() < dob.getDate()) age -= 1;
  return age;
}
function isApplicantAgeEligible(dateOfBirth, now = /* @__PURE__ */ new Date()) {
  const age = getApplicantAge(dateOfBirth, now);
  return age != null && age >= MIN_APPLICANT_AGE;
}
export {
  MIN_APPLICANT_AGE,
  getApplicantAge,
  isApplicantAgeEligible
};
