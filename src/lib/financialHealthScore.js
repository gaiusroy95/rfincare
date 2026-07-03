/**
 * Customer financial health score with category breakdown and improvement actions.
 */

function clampScore(value, max) {
  return Math.max(0, Math.min(max, Math.round(value)));
}

function leadCount(value) {
  if (Array.isArray(value)) return value.length;
  return Number(value) || 0;
}

function creditBorrowingBoost(creditScore) {
  const score = Number(creditScore);
  if (!Number.isFinite(score)) return 0;
  if (score >= 750) return 8;
  if (score >= 700) return 5;
  if (score >= 650) return 2;
  return 0;
}

export function buildFinancialHealthModel({
  activeLoans = [],
  verifiedDocs = 0,
  pendingDocs = 0,
  insurancePolicies = 0,
  insuranceLeads = 0,
  sipLeads = 0,
  fixedDepositLeads = 0,
  hasPhone = false,
  hasCustomerCode = false,
  hasEmail = false,
  creditScore = null,
}) {
  const insuranceLeadCount = leadCount(insuranceLeads);
  const sipLeadCount = leadCount(sipLeads);
  const fixedDepositLeadCount = leadCount(fixedDepositLeads);

  const protectionScore = clampScore(
    (insurancePolicies > 0 ? 18 : insuranceLeadCount > 0 ? 8 : 0)
    + (insurancePolicies > 1 ? 2 : 0),
    20,
  );

  const investmentScore = clampScore(
    (sipLeadCount > 0 ? 12 : 0)
    + (fixedDepositLeadCount > 0 ? 8 : 0)
    + (sipLeadCount > 1 ? 5 : 0),
    20,
  );

  const pendingDocCount = Array.isArray(pendingDocs) ? pendingDocs.length : Number(pendingDocs) || 0;
  const borrowingScore = clampScore(
    (activeLoans.length > 0 ? 12 : 4) + creditBorrowingBoost(creditScore),
    20,
  ) + clampScore(
    activeLoans.length > 0 && pendingDocCount === 0 ? 8 : Math.max(0, 8 - pendingDocCount * 2),
    8,
  );

  const profileScore = clampScore(
    (hasPhone ? 8 : 0)
    + (hasCustomerCode ? 7 : 0)
    + (hasEmail ? 5 : 0)
    + clampScore(verifiedDocs * 2, 10),
    25,
  );

  const documentsScore = clampScore(
    pendingDocCount === 0 ? 15 : Math.max(0, 15 - pendingDocCount * 3),
    15,
  );

  const breakdown = [
    {
      id: 'protection',
      label: 'Protection',
      score: protectionScore,
      max: 20,
      icon: 'Shield',
      description: 'Life and health insurance coverage',
    },
    {
      id: 'investments',
      label: 'Investments',
      score: investmentScore,
      max: 20,
      icon: 'TrendingUp',
      description: 'SIPs, mutual funds and fixed income',
    },
    {
      id: 'borrowing',
      label: 'Borrowing',
      score: borrowingScore,
      max: 20,
      icon: 'Landmark',
      description: 'Loan applications and repayment readiness',
    },
    {
      id: 'profile',
      label: 'Profile',
      score: profileScore,
      max: 25,
      icon: 'User',
      description: 'Contact details and verified documents',
    },
    {
      id: 'documents',
      label: 'Documents',
      score: documentsScore,
      max: 15,
      icon: 'FileCheck',
      description: 'Pending uploads and KYC completeness',
    },
  ];

  const totalScore = Math.min(
    100,
    breakdown.reduce((sum, item) => sum + item.score, 0),
  );

  const improvementActions = [];

  if (protectionScore < 15) {
    improvementActions.push({
      id: 'get-insurance',
      category: 'protection',
      title: insuranceLeadCount ? 'Complete your insurance enquiry' : 'Get term or health insurance',
      description: insuranceLeadCount
        ? 'You started an insurance enquiry — compare plans and buy online.'
        : 'Protect your family with life or health cover from top insurers.',
      path: '/insurance-marketplace',
      cta: insuranceLeadCount ? 'Continue insurance' : 'Compare plans',
      pointsGain: Math.min(20, 20 - protectionScore),
      priority: 'high',
    });
  }

  if (investmentScore < 12) {
    improvementActions.push({
      id: 'start-sip',
      category: 'investments',
      title: 'Start a mutual fund SIP',
      description: 'Build long-term wealth from ₹500/month with curated fund options.',
      path: '/mutual-fund-marketplace',
      cta: 'Explore mutual funds',
      pointsGain: Math.min(20, 20 - investmentScore),
      priority: 'high',
    });
  }

  if (fixedDepositLeadCount === 0 && investmentScore < 18) {
    improvementActions.push({
      id: 'tax-saving',
      category: 'investments',
      title: 'Explore tax-saving investments',
      description: 'ELSS, tax-saving FDs and post office schemes under Section 80C.',
      path: '/tax-saving',
      cta: 'View tax-saving options',
      pointsGain: 8,
      priority: 'medium',
    });
  }

  if (pendingDocCount > 0) {
    improvementActions.push({
      id: 'upload-docs',
      category: 'documents',
      title: `Upload ${pendingDocCount} pending document${pendingDocCount > 1 ? 's' : ''}`,
      description: 'Complete KYC to speed up loan and product approvals.',
      path: '/customer-dashboard?tab=documents',
      cta: 'Upload now',
      pointsGain: Math.min(15, pendingDocCount * 3),
      priority: 'high',
    });
  }

  if (!hasPhone || !hasCustomerCode) {
    improvementActions.push({
      id: 'complete-profile',
      category: 'profile',
      title: 'Complete your profile',
      description: 'Add missing contact details for faster product onboarding.',
      path: '/profile',
      cta: 'Update profile',
      pointsGain: Math.min(15, 25 - profileScore),
      priority: 'medium',
    });
  }

  if (creditScore != null && Number(creditScore) < 700) {
    improvementActions.push({
      id: 'improve-credit',
      category: 'borrowing',
      title: 'Improve your credit score',
      description: 'Pay EMIs on time and keep credit utilisation low to unlock better loan rates.',
      path: '/customer-dashboard?tab=portfolio',
      cta: 'View credit profile',
      pointsGain: Math.min(8, 700 - Number(creditScore) > 50 ? 5 : 8),
      priority: 'medium',
    });
  }

  if (activeLoans.length === 0) {
    improvementActions.push({
      id: 'check-eligibility',
      category: 'borrowing',
      title: 'Check loan eligibility',
      description: 'See how much you can borrow for home, personal or business needs.',
      path: '/eligibility-assessment',
      cta: 'Check eligibility',
      pointsGain: 8,
      priority: 'low',
    });
  }

  improvementActions.push({
    id: 'retirement-plan',
    category: 'investments',
    title: 'Plan your retirement',
    description: 'Use our retirement corpus planner to estimate your future needs.',
    path: '/resources/calculators/retirement-corpus',
    cta: 'Open planner',
    pointsGain: 0,
    priority: 'low',
  });

  const sortedActions = improvementActions
    .sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      return (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9);
    })
    .slice(0, 5);

  const nextBestAction = sortedActions[0] || null;

  return {
    financialHealthScore: totalScore,
    breakdown,
    improvementActions: sortedActions,
    nextBestAction,
    grade:
      totalScore >= 80 ? 'Excellent'
        : totalScore >= 65 ? 'Good'
          : totalScore >= 45 ? 'Fair'
            : 'Needs attention',
  };
}
