/**
 * Pluggable bank account verification for agent onboarding.
 * When BANK_VERIFY_PROVIDER is cashfree/razorpayx and keys are present, stubs a provider call.
 * Otherwise returns pending_verification for manual ops review.
 */

function providerFromEnv() {
  return String(process.env.BANK_VERIFY_PROVIDER || '').trim().toLowerCase();
}

function cashfreeConfigured() {
  return Boolean(
    process.env.CASHFREE_CLIENT_ID
    && process.env.CASHFREE_CLIENT_SECRET,
  );
}

function razorpayxConfigured() {
  return Boolean(
    process.env.RAZORPAYX_KEY_ID
    && process.env.RAZORPAYX_KEY_SECRET,
  );
}

/**
 * @param {{ holderName?: string, accountNumber?: string, ifsc?: string, accountType?: string }} bank
 * @returns {Promise<{ status: string, provider: string, reference?: string|null, raw?: object|null }>}
 */
export async function verifyBankAccount(bank = {}) {
  const provider = providerFromEnv();
  const payload = {
    holderName: String(bank.holderName || '').trim(),
    accountNumber: String(bank.accountNumber || '').trim(),
    ifsc: String(bank.ifsc || '').trim().toUpperCase(),
    accountType: String(bank.accountType || '').trim() || null,
  };

  if (provider === 'cashfree' && cashfreeConfigured()) {
    // Stub: wire real Cashfree Penny Drop / bank verification when credentials + product are live.
    return {
      status: 'pending_verification',
      provider: 'cashfree',
      reference: null,
      raw: { stub: true, reason: 'cashfree_provider_not_wired', accountHint: payload.accountNumber.slice(-4) },
    };
  }

  if ((provider === 'razorpayx' || provider === 'razorpay') && razorpayxConfigured()) {
    // Stub: wire RazorpayX fund-account validation when product is enabled.
    return {
      status: 'pending_verification',
      provider: 'razorpayx',
      reference: null,
      raw: { stub: true, reason: 'razorpayx_provider_not_wired', accountHint: payload.accountNumber.slice(-4) },
    };
  }

  return {
    status: 'pending_verification',
    provider: 'manual',
    reference: null,
    raw: null,
  };
}
