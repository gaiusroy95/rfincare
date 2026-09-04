/**
 * Canonical legal / policy page catalog.
 * Kept in sync with frontend `constants/legalPages.js` and footer links.
 */

export const LEGAL_PAGE_CATALOG = [
  // General
  {
    slug: 'privacy-policy',
    title: 'Privacy Policy',
    section: 'general',
    bodyHtml: `
<h2>1. Introduction</h2>
<p>Rfincare ("we", "us", or "our") respects your privacy. This Privacy Policy explains how we collect, use, store, and protect personal information when you use our website, apps, and related services.</p>
<h2>2. Information we collect</h2>
<p>We may collect identity and contact details, KYC documents, financial and employment information, device/usage data, and communications you send to us, as needed to provide loan advisory and related financial product comparison services.</p>
<h2>3. How we use information</h2>
<ul>
<li>To assess eligibility and match you with partner lenders / product providers</li>
<li>To process applications, verifications, and customer support requests</li>
<li>To meet legal, regulatory, audit, and fraud-prevention obligations</li>
<li>To improve our platform, security, and service quality</li>
</ul>
<h2>4. Sharing of information</h2>
<p>We may share relevant information with partner banks, NBFCs, insurers, credit information companies, technology vendors, and regulators — only as required to deliver requested services or comply with law. We do not sell personal data.</p>
<h2>5. Data security &amp; retention</h2>
<p>We apply reasonable technical and organisational safeguards. Retention periods follow business need, contractual requirements, and applicable law. See also our Data Retention Policy.</p>
<h2>6. Your rights</h2>
<p>Subject to applicable law, you may request access, correction, or deletion of your data, or withdraw consent where processing is consent-based. Contact us via the details on our Contact Us page or Grievance Redressal Policy.</p>
<h2>7. Updates</h2>
<p>We may update this policy from time to time. The "Last updated" date on this page reflects the latest revision. Continued use of our services after changes constitutes acceptance of the updated policy.</p>
`.trim(),
  },
  {
    slug: 'terms-of-service',
    title: 'Terms of Service',
    section: 'general',
    bodyHtml: `
<h2>1. Agreement</h2>
<p>By accessing or using Rfincare's website, apps, or services, you agree to these Terms of Service and our Privacy Policy. If you do not agree, please do not use our services.</p>
<h2>2. Nature of services</h2>
<p>Rfincare provides digital loan advisory, product comparison, and facilitation services. We are not a bank or NBFC and do not ourselves lend money unless expressly stated. Final credit decisions, rates, and product terms are determined by partner institutions.</p>
<h2>3. Eligibility</h2>
<p>You must be legally competent to contract under Indian law and provide accurate information. You are responsible for safeguarding account credentials and OTP access.</p>
<h2>4. User obligations</h2>
<ul>
<li>Provide true, complete, and current information</li>
<li>Use the platform only for lawful purposes</li>
<li>Not misuse APIs, scrape content, or attempt unauthorised access</li>
</ul>
<h2>5. Intellectual property</h2>
<p>All trademarks, logos, content, and software on the platform remain the property of Rfincare or its licensors. You receive a limited, non-exclusive licence to use the services for personal, non-commercial purposes.</p>
<h2>6. Disclaimers &amp; liability</h2>
<p>Services are provided on an "as available" basis. To the fullest extent permitted by law, Rfincare is not liable for partner decisions, third-party outages, or indirect damages. See also our Disclaimer.</p>
<h2>7. Termination</h2>
<p>We may suspend or terminate access for violation of these terms, fraud risk, or legal requirement. Provisions that by nature should survive will continue after termination.</p>
<h2>8. Governing law</h2>
<p>These terms are governed by the laws of India. Courts at the jurisdiction stated in our grievance policy shall have exclusive jurisdiction, subject to applicable law.</p>
`.trim(),
  },
  {
    slug: 'cookie-policy',
    title: 'Cookie Policy',
    section: 'general',
    bodyHtml: `
<h2>1. What are cookies?</h2>
<p>Cookies and similar technologies are small files stored on your device that help websites function, remember preferences, and understand usage.</p>
<h2>2. How Rfincare uses cookies</h2>
<ul>
<li><strong>Essential:</strong> login sessions, security, load balancing</li>
<li><strong>Functional:</strong> language, theme, and form progress preferences</li>
<li><strong>Analytics:</strong> aggregated traffic and performance insights (where enabled)</li>
</ul>
<h2>3. Managing cookies</h2>
<p>You can control cookies through your browser settings. Blocking essential cookies may limit site functionality (for example, staying signed in).</p>
<h2>4. Third parties</h2>
<p>Some partners or analytics providers may set their own cookies subject to their policies. We encourage you to review those policies separately.</p>
<h2>5. Updates</h2>
<p>We may revise this Cookie Policy as our practices or legal requirements change.</p>
`.trim(),
  },
  {
    slug: 'help-center',
    title: 'Help Center',
    section: 'general',
    bodyHtml: `
<h2>How can we help?</h2>
<p>Find quick answers below. For personalised support, use Contact Us or Talk to Expert from the website.</p>
<h2>1. Applications &amp; eligibility</h2>
<ul>
<li>Complete eligibility assessment with accurate income and KYC details</li>
<li>Track application status from your customer dashboard or status check</li>
<li>Respond promptly to document requests to avoid delays</li>
</ul>
<h2>2. Login &amp; OTP</h2>
<ul>
<li>Use the registered mobile/email for OTP</li>
<li>If OTP is delayed, wait for the cooldown and retry; check spam for email OTP</li>
<li>Reset password only through the official OTP flow in your portal</li>
</ul>
<h2>3. Partners &amp; products</h2>
<p>Displayed rates and offers are indicative. Final sanction depends on the partner bank/NBFC/insurer after their underwriting.</p>
<h2>4. Still need help?</h2>
<p>Visit Contact Us, or refer to our Grievance Redressal Policy for escalation timelines and contacts.</p>
`.trim(),
  },
  {
    slug: 'financial-guides',
    title: 'Financial Guides',
    section: 'general',
    bodyHtml: `
<h2>Financial guides</h2>
<p>Educational articles and calculators on Rfincare are for general information only and are not personalised investment, tax, or legal advice.</p>
<h2>Topics we cover</h2>
<ul>
<li>Home loans, personal loans, and secured credit basics</li>
<li>CIBIL / credit score hygiene</li>
<li>EMI planning and FOIR concepts</li>
<li>Insurance and investment product overviews</li>
</ul>
<h2>How to use these guides</h2>
<p>Use guides together with our calculators and eligibility tools, then consult a qualified advisor or partner institution before making financial decisions.</p>
`.trim(),
  },
  {
    slug: 'careers',
    title: 'Careers',
    section: 'general',
    bodyHtml: `
<h2>Build with Rfincare</h2>
<p>We are building technology-led financial access for India. If you care about product, risk, customer experience, or partnerships, we would like to hear from you.</p>
<h2>How to apply</h2>
<p>Send your profile and role interest through Contact Us, or watch this page for open positions. Include relevant experience in lending, fintech, compliance, sales, or engineering where applicable.</p>
<h2>Equal opportunity</h2>
<p>Rfincare is an equal opportunity employer. We evaluate candidates based on skills, experience, and alignment with our values.</p>
`.trim(),
  },

  // Policies & Disclosures
  {
    slug: 'disclaimer',
    title: 'Disclaimer',
    section: 'policies',
    bodyHtml: `
<h2>1. General</h2>
<p>Content on Rfincare is provided for informational purposes. Product features, interest rates, fees, and eligibility criteria shown on the platform are indicative and may change without notice.</p>
<h2>2. No lending commitment</h2>
<p>Rfincare does not guarantee loan approval, disbursement, insurance issuance, or investment returns. All decisions rest with the respective partner institutions subject to their policies and applicable regulations.</p>
<h2>3. No professional advice</h2>
<p>Nothing on this website constitutes legal, tax, accounting, or investment advice. Seek independent professional advice before acting on any information.</p>
<h2>4. Third-party links &amp; partners</h2>
<p>We are not responsible for the content, privacy practices, or services of third-party sites or partner portals you may be redirected to.</p>
<h2>5. Limitation</h2>
<p>To the maximum extent permitted by law, Rfincare disclaims liability for losses arising from reliance on platform content or partner outcomes.</p>
`.trim(),
  },
  {
    slug: 'grievance-redressal-policy',
    title: 'Grievance Redressal Policy',
    section: 'policies',
    bodyHtml: `
<h2>1. Purpose</h2>
<p>This policy describes how customers and partners can raise concerns related to Rfincare's digital platform, facilitation services, and communications, and how we aim to resolve them.</p>
<h2>2. How to raise a grievance</h2>
<ol>
<li>Contact support via the Contact Us form or registered email/phone channels published on the website.</li>
<li>Provide your application/lead reference (if any), registered mobile/email, and a clear description of the issue.</li>
<li>Retain the acknowledgement or ticket reference for follow-up.</li>
</ol>
<h2>3. Resolution timelines</h2>
<ul>
<li><strong>Acknowledgement:</strong> typically within 2 business days</li>
<li><strong>Resolution / interim update:</strong> typically within 15 business days (complex cases may take longer with written updates)</li>
</ul>
<h2>4. Escalation</h2>
<p>If you are not satisfied with the first response, you may escalate to the Grievance Officer using the escalation contact published on Contact Us / this page (as updated by admin). For partner-product issues (sanction, charges, repayment), the partner bank/NBFC's own grievance process may also apply.</p>
<h2>5. Records</h2>
<p>We maintain grievance records for audit and continuous improvement as required by internal policy and applicable law.</p>
`.trim(),
  },
  {
    slug: 'fair-practices-code',
    title: 'Fair Practices Code',
    section: 'policies',
    bodyHtml: `
<h2>1. Commitment</h2>
<p>Rfincare follows fair, transparent, and non-discriminatory practices while facilitating access to credit and related financial products through partner institutions.</p>
<h2>2. Transparency</h2>
<ul>
<li>We strive to present key product features, fees, and process steps clearly</li>
<li>We do not guarantee approval or specific pricing on behalf of partners</li>
<li>Customers are informed that final terms are set by the partner</li>
</ul>
<h2>3. Applications &amp; documents</h2>
<p>We collect only information reasonably required for facilitation, KYC, and partner underwriting. Customers should receive clear document checklists where applicable.</p>
<h2>4. Marketing &amp; conduct</h2>
<p>Our agents, DSAs, and employees are expected to communicate honestly, avoid harassment, and respect customer privacy. See also Code of Conduct for DSAs &amp; Employees.</p>
<h2>5. Complaints</h2>
<p>Complaints are handled under our Grievance Redressal Policy.</p>
`.trim(),
  },
  {
    slug: 'kyc-aml-policy',
    title: 'KYC & AML Policy',
    section: 'policies',
    bodyHtml: `
<h2>1. Purpose</h2>
<p>This policy outlines Rfincare's approach to Know Your Customer (KYC) and Anti-Money Laundering (AML) controls when facilitating financial products with regulated partners.</p>
<h2>2. Customer identification</h2>
<p>We may collect and verify identity, address, photograph, PAN, and other KYC artefacts as required by partners and applicable regulations before processing applications.</p>
<h2>3. Monitoring &amp; suspicious activity</h2>
<p>Unusual patterns, mismatched information, or suspected fraud may lead to additional verification, application holds, or reporting to partners/authorities as required by law.</p>
<h2>4. Record keeping</h2>
<p>KYC and related records are retained and protected per our Data Retention and Privacy policies and partner contractual requirements.</p>
<h2>5. Roles</h2>
<p>Partner banks/NBFCs remain responsible for their own regulated KYC/AML obligations. Rfincare supports collection and secure transmission of information as a facilitator/technology platform.</p>
`.trim(),
  },
  {
    slug: 'refund-cancellation-policy',
    title: 'Refund & Cancellation Policy',
    section: 'policies',
    bodyHtml: `
<h2>1. Scope</h2>
<p>This policy covers fees (if any) charged by Rfincare for platform or facilitation services. Partner bank/NBFC/insurer fees, EMIs, premiums, and charges are governed by the partner's terms.</p>
<h2>2. Platform fees</h2>
<p>Where Rfincare charges a disclosed service fee, eligibility for refund depends on the specific service purchased, stage of fulfilment, and reason for cancellation. Non-refundable components (for example, third-party verification costs already incurred) will be stated at checkout or in the order confirmation.</p>
<h2>3. Cancellations by customer</h2>
<p>You may withdraw an in-progress application request on Rfincare; this does not automatically cancel any application already submitted to a partner. Contact support promptly with your reference number.</p>
<h2>4. Partner products</h2>
<p>Loan cancellations, foreclosure, insurance free-look, and investment redemptions follow the respective partner's policy and regulatory rules. Rfincare will guide you to the correct partner channel where possible.</p>
<h2>5. How to request a refund</h2>
<p>Write to us via Contact Us with payment reference, date, and reason. Approved refunds are processed to the original payment method within a reasonable banking timeline.</p>
`.trim(),
  },
  {
    slug: 'data-retention-policy',
    title: 'Data Retention Policy',
    section: 'policies',
    bodyHtml: `
<h2>1. Purpose</h2>
<p>This Data Retention Policy explains how long Rfincare retains personal and transactional data collected through our platform and related operations.</p>
<h2>2. Retention principles</h2>
<ul>
<li>Retain data only as long as needed for the purpose collected</li>
<li>Honour contractual and regulatory retention requirements</li>
<li>Securely delete or anonymise data when retention ends, subject to legal holds</li>
</ul>
<h2>3. Typical categories</h2>
<ul>
<li><strong>Account &amp; profile data:</strong> while the account is active and for a reasonable period thereafter</li>
<li><strong>Application / KYC artefacts:</strong> as required for partner facilitation, audits, and dispute resolution</li>
<li><strong>Support &amp; grievance records:</strong> for the period needed to close and audit complaints</li>
<li><strong>Logs &amp; security events:</strong> for operational security and forensics windows</li>
</ul>
<h2>4. Legal holds</h2>
<p>Data subject to investigation, litigation, or regulatory request may be retained longer than standard schedules.</p>
<h2>5. Requests</h2>
<p>Deletion or access requests are handled under our Privacy Policy, subject to legal exceptions (for example, ongoing applications or statutory retention).</p>
`.trim(),
  },
  {
    slug: 'consent-data-collection-credit-bureau',
    title: 'Consent for Data Collection & Credit Bureau Access',
    section: 'policies',
    bodyHtml: `
<h2>1. Consent overview</h2>
<p>By proceeding with eligibility checks, applications, or related journeys on Rfincare, you consent to collection and processing of your personal, KYC, and financial information for the stated purposes.</p>
<h2>2. Credit information</h2>
<p>Where required, you authorise Rfincare and/or partner lenders to fetch your credit information from one or more Credit Information Companies (CICs) such as CIBIL / Experian / Equifax / CRIF High Mark, in accordance with applicable laws and CIC terms.</p>
<h2>3. What this enables</h2>
<ul>
<li>Eligibility assessment and product matching</li>
<li>Fraud and identity checks</li>
<li>Partner underwriting and offer generation</li>
</ul>
<h2>4. Withdrawal of consent</h2>
<p>You may withdraw consent prospectively where legally permitted; withdrawal may prevent us or partners from continuing services that require that processing. Processing already completed based on prior consent remains valid.</p>
<h2>5. Records</h2>
<p>Consent timestamps, OTP verifications, and related artefacts may be retained as proof of authorisation.</p>
`.trim(),
  },
  {
    slug: 'digital-lending-disclosure',
    title: 'Digital Lending Disclosure',
    section: 'policies',
    bodyHtml: `
<h2>1. Role of Rfincare</h2>
<p>Rfincare operates as a digital platform that helps users discover, compare, and apply for credit and related products offered by regulated partner banks / NBFCs. Unless expressly stated, Rfincare is not the lender of record.</p>
<h2>2. Key disclosures</h2>
<ul>
<li>Loan sanction, pricing, repayment schedule, and recovery are determined by the partner lender</li>
<li>KFS / key fact statements (where applicable) are provided by the partner as per RBI digital lending guidelines</li>
<li>Cooling-off, grievance, and recovery practices follow partner and regulatory requirements</li>
</ul>
<h2>3. Data &amp; outsourcing</h2>
<p>Data shared with partners is limited to what is needed for underwriting and servicing. Technology and operational vendors may process data under contractual confidentiality and security obligations.</p>
<h2>4. Customer awareness</h2>
<p>Before accepting an offer, review the partner's sanction letter, interest rate type, fees, and repayment obligations carefully.</p>
`.trim(),
  },
  {
    slug: 'partner-bank-nbfc-disclosure',
    title: 'Partner Bank & NBFC Disclosure',
    section: 'policies',
    bodyHtml: `
<h2>1. Partner model</h2>
<p>Rfincare works with multiple banks, NBFCs, HFCs, insurers, and other product providers. The list of active partners may change based on commercial arrangements and product availability in your location.</p>
<h2>2. What partners decide</h2>
<ul>
<li>Eligibility, risk assessment, and approval</li>
<li>Interest rates, fees, tenure, and documentation</li>
<li>Disbursement, servicing, and collections</li>
</ul>
<h2>3. Rfincare's role</h2>
<p>We facilitate discovery, information collection, document workflows, and status tracking. Marketing content about partners is descriptive and not an endorsement of every product feature.</p>
<h2>4. Updates</h2>
<p>Partner names and product catalogues displayed on the marketplace are updated periodically. Always verify final terms with the partner before proceeding.</p>
`.trim(),
  },
  {
    slug: 'code-of-conduct-dsa-employees',
    title: 'Code of Conduct for DSAs & Employees',
    section: 'policies',
    bodyHtml: `
<h2>1. Applicability</h2>
<p>This code applies to Rfincare employees, agents, DSAs, and other representatives interacting with customers on our behalf.</p>
<h2>2. Expected conduct</h2>
<ul>
<li>Be truthful about products, process, and Rfincare's role</li>
<li>Do not promise guaranteed approvals or fabricated rates</li>
<li>Respect customer privacy and data minimisation</li>
<li>No harassment, discrimination, or coercive collection practices</li>
<li>Disclose conflicts of interest where required</li>
</ul>
<h2>3. Prohibited behaviour</h2>
<p>Falsifying KYC, coaching fraudulent applications, charging undisclosed fees, or misusing customer OTPs/credentials is strictly prohibited and may lead to termination and legal action.</p>
<h2>4. Reporting</h2>
<p>Violations can be reported through internal channels or customer grievance routes. Retaliation against good-faith reporters is not tolerated.</p>
`.trim(),
  },
  {
    slug: 'security-fraud-awareness',
    title: 'Security & Fraud Awareness',
    section: 'policies',
    bodyHtml: `
<h2>1. Protect your account</h2>
<ul>
<li>Never share OTP, passwords, or CVV with anyone — including people claiming to be Rfincare staff</li>
<li>Use official website/app URLs only</li>
<li>Enable device lock and keep software updated</li>
</ul>
<h2>2. Common fraud patterns</h2>
<ul>
<li>Calls/SMS promising guaranteed loans after an advance fee</li>
<li>Phishing links that mimic login or KYC pages</li>
<li>Requests to install remote-access apps</li>
</ul>
<h2>3. What Rfincare will never do</h2>
<p>We will not ask you to pay undisclosed cash fees for loan approval via personal UPI/wallets, or to share OTP to "verify" your account over a phone call.</p>
<h2>4. Report suspicion</h2>
<p>If you suspect fraud, stop communication, secure your accounts, and contact us immediately via Contact Us / grievance channels. Also consider reporting to cybercrime.gov.in / local authorities where appropriate.</p>
`.trim(),
  },
  {
    slug: 'accessibility-statement',
    title: 'Accessibility Statement',
    section: 'policies',
    bodyHtml: `
<h2>1. Our commitment</h2>
<p>Rfincare aims to make its digital experiences usable for as many people as possible, including users of assistive technologies.</p>
<h2>2. Measures we take</h2>
<ul>
<li>Semantic structure and readable typography where feasible</li>
<li>Keyboard-accessible navigation for key flows</li>
<li>Colour contrast aligned with our design system</li>
<li>Ongoing fixes based on user feedback</li>
</ul>
<h2>3. Known limitations</h2>
<p>Some legacy or third-party embedded experiences may not yet meet the same accessibility standard. We prioritise remediation based on impact.</p>
<h2>4. Feedback</h2>
<p>If you encounter an accessibility barrier, contact us via Contact Us with the page URL and a short description. We will work to provide a reasonable alternative or fix.</p>
`.trim(),
  },
];

export const LEGAL_PAGE_BY_SLUG = new Map(LEGAL_PAGE_CATALOG.map((p) => [p.slug, p]));

export function getCatalogLegalPage(slug) {
  return LEGAL_PAGE_BY_SLUG.get(String(slug || '').trim()) || null;
}

export function listCatalogLegalPages() {
  return LEGAL_PAGE_CATALOG.map(({ slug, title, section }) => ({ slug, title, section }));
}

function mapLegalRow(row, fallback = {}) {
  if (!row && !fallback.slug) return null;
  return {
    slug: row?.slug ?? fallback.slug,
    title: row?.title ?? fallback.title ?? fallback.slug,
    bodyHtml: row?.body_html ?? row?.bodyhtml ?? row?.bodyHtml ?? fallback.bodyHtml ?? '',
    updatedAt: row?.updated_at ?? row?.updatedat ?? row?.updatedAt ?? null,
  };
}

/**
 * Insert any missing catalog pages. Does not overwrite existing customised content.
 * Upgrades known stub placeholders from early migrations to full starter HTML.
 */
export async function ensureLegalPages(pool) {
  if (!pool) return { inserted: 0, upgraded: 0 };
  let inserted = 0;
  let upgraded = 0;
  for (const page of LEGAL_PAGE_CATALOG) {
    const [[existing]] = await pool.query(
      `SELECT slug, body_html FROM legal_pages WHERE slug = :slug LIMIT 1`,
      { slug: page.slug },
    );
    if (!existing) {
      await pool.execute(
        `INSERT INTO legal_pages (slug, title, body_html, updated_at)
         VALUES (:slug, :title, :body, NOW())
         ON CONFLICT (slug) DO NOTHING`,
        {
          slug: page.slug,
          title: page.title,
          body: page.bodyHtml,
        },
      );
      inserted += 1;
      continue;
    }
    const body = String(existing.body_html ?? existing.bodyhtml ?? '');
    const isStub =
      !body.trim()
      || /content managed by admin\.?/i.test(body)
      || /^<p>\s*[^<]{0,80}content managed by admin[^<]{0,40}\s*<\/p>$/i.test(body.trim());
    if (isStub) {
      await pool.execute(
        `UPDATE legal_pages
         SET title = :title, body_html = :body, updated_at = NOW()
         WHERE slug = :slug`,
        { slug: page.slug, title: page.title, body: page.bodyHtml },
      );
      upgraded += 1;
    }
  }
  return { inserted, upgraded };
}

export async function getLegalPageBySlug(pool, slug, { createIfMissing = true } = {}) {
  const normalized = String(slug || '').trim();
  const catalog = getCatalogLegalPage(normalized);
  if (!normalized) return null;

  if (createIfMissing) {
    await ensureLegalPages(pool);
  }

  const [[row]] = await pool.query(
    `SELECT slug, title, body_html, updated_at FROM legal_pages WHERE slug = :slug`,
    { slug: normalized },
  );

  if (row) return mapLegalRow(row);

  if (createIfMissing && catalog) {
    await pool.execute(
      `INSERT INTO legal_pages (slug, title, body_html, updated_at)
       VALUES (:slug, :title, :body, NOW())
       ON CONFLICT (slug) DO NOTHING`,
      { slug: catalog.slug, title: catalog.title, body: catalog.bodyHtml },
    );
    const [[again]] = await pool.query(
      `SELECT slug, title, body_html, updated_at FROM legal_pages WHERE slug = :slug`,
      { slug: normalized },
    );
    return mapLegalRow(again, catalog);
  }

  // Unknown slug outside catalog — still allow if present; else null
  return null;
}

export async function upsertLegalPage(pool, { slug, title, bodyHtml, updatedBy }) {
  const normalized = String(slug || '').trim();
  const catalog = getCatalogLegalPage(normalized);
  const safeTitle = String(title || catalog?.title || normalized).trim();
  const safeBody = bodyHtml == null ? '' : String(bodyHtml);

  await pool.execute(
    `INSERT INTO legal_pages (slug, title, body_html, updated_by, updated_at)
     VALUES (:slug, :title, :body, :by, NOW())
     ON CONFLICT (slug) DO UPDATE SET
       title = EXCLUDED.title,
       body_html = EXCLUDED.body_html,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    {
      slug: normalized,
      title: safeTitle,
      body: safeBody,
      by: updatedBy ?? null,
    },
  );

  return getLegalPageBySlug(pool, normalized, { createIfMissing: false });
}
