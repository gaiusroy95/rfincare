import { getCustomerCreditProfile } from './customerCreditScore.js';
import { pullCibilForCustomer } from './cibilService.js';

const REFRESH_COOLDOWN_DAYS = 30;

function numericScoreToRangeKey(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return null;
  if (n >= 750) return 'excellent';
  if (n >= 700) return 'good';
  if (n >= 650) return 'fair';
  return 'poor';
}

/**
 * Resolve live or cached bureau score for customer eligibility.
 * Uses cached pull when fresh; attempts live pull when requested with consent.
 */
export async function resolveLiveCibilForCustomerEligibility(customerId, input = {}) {
  const profile = await getCustomerCreditProfile(customerId);
  const refreshRequested = Boolean(input.fetchLiveCibil || input.refreshLiveCibil);

  if (profile.bureauScore && profile.bureauCheckedAt && !refreshRequested) {
    const daysSince =
      (Date.now() - new Date(profile.bureauCheckedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < REFRESH_COOLDOWN_DAYS) {
      return {
        creditScore: profile.bureauScore,
        creditScoreRange: numericScoreToRangeKey(profile.bureauScore),
        cibil: {
          score: profile.bureauScore,
          source: 'cached',
          checkedAt: profile.bureauCheckedAt,
          vendorName: profile.bureauVendor,
          band: profile.band,
        },
      };
    }
  }

  if (!refreshRequested || !input.consentAccepted) {
    if (profile.bureauScore) {
      return {
        creditScore: profile.bureauScore,
        creditScoreRange: numericScoreToRangeKey(profile.bureauScore),
        cibil: {
          score: profile.bureauScore,
          source: 'cached',
          checkedAt: profile.bureauCheckedAt,
          vendorName: profile.bureauVendor,
          band: profile.band,
        },
      };
    }
    return null;
  }

  try {
    const demographics = {};
    if (input.panNumber) {
      demographics.panNumber = String(input.panNumber).trim().toUpperCase();
    }
    const pull = await pullCibilForCustomer(customerId, { demographics });
    if (pull?.creditScore) {
      return {
        creditScore: pull.creditScore,
        creditScoreRange: numericScoreToRangeKey(pull.creditScore),
        cibil: {
          score: pull.creditScore,
          source: pull.sandboxMode ? 'live_sandbox' : 'live',
          checkedAt: new Date().toISOString(),
          vendorName: pull.vendorName,
          sandboxMode: Boolean(pull.sandboxMode),
          band: numericScoreToRangeKey(pull.creditScore),
        },
      };
    }
  } catch (err) {
    if (err.status === 429 && err.latestCheck?.creditScore) {
      return {
        creditScore: err.latestCheck.creditScore,
        creditScoreRange: numericScoreToRangeKey(err.latestCheck.creditScore),
        cibil: {
          score: err.latestCheck.creditScore,
          source: 'cached',
          checkedAt: err.latestCheck.checkedAt,
          vendorName: err.latestCheck.vendorName,
          band: numericScoreToRangeKey(err.latestCheck.creditScore),
          notice: err.message,
        },
      };
    }
    if (profile.bureauScore) {
      return {
        creditScore: profile.bureauScore,
        creditScoreRange: numericScoreToRangeKey(profile.bureauScore),
        cibil: {
          score: profile.bureauScore,
          source: 'cached_fallback',
          checkedAt: profile.bureauCheckedAt,
          vendorName: profile.bureauVendor,
          band: profile.band,
          error: err.message,
        },
      };
    }
    return {
      cibil: {
        source: 'unavailable',
        error: err.message || 'Could not fetch live CIBIL score',
      },
    };
  }

  return null;
}
