-- Ensure all Policies & Disclosures + General legal pages exist.
-- Full starter HTML is applied by backend ensureLegalPages() on first read/update;
-- this migration inserts stubs safely if rows are missing.

INSERT INTO legal_pages (slug, title, body_html) VALUES
('privacy-policy', 'Privacy Policy', '<p>Privacy policy content managed by admin.</p>'),
('terms-of-service', 'Terms of Service', '<p>Terms of service content managed by admin.</p>'),
('cookie-policy', 'Cookie Policy', '<p>Cookie policy content managed by admin.</p>'),
('help-center', 'Help Center', '<p>Help center content managed by admin.</p>'),
('financial-guides', 'Financial Guides', '<p>Financial guides content managed by admin.</p>'),
('careers', 'Careers', '<p>Careers content managed by admin.</p>'),
('disclaimer', 'Disclaimer', '<p>Disclaimer content managed by admin.</p>'),
('grievance-redressal-policy', 'Grievance Redressal Policy', '<p>Grievance redressal policy content managed by admin.</p>'),
('fair-practices-code', 'Fair Practices Code', '<p>Fair practices code content managed by admin.</p>'),
('kyc-aml-policy', 'KYC & AML Policy', '<p>KYC and AML policy content managed by admin.</p>'),
('refund-cancellation-policy', 'Refund & Cancellation Policy', '<p>Refund and cancellation policy content managed by admin.</p>'),
('data-retention-policy', 'Data Retention Policy', '<p>Data retention policy content managed by admin.</p>'),
('consent-data-collection-credit-bureau', 'Consent for Data Collection & Credit Bureau Access', '<p>Consent for data collection and credit bureau access content managed by admin.</p>'),
('digital-lending-disclosure', 'Digital Lending Disclosure', '<p>Digital lending disclosure content managed by admin.</p>'),
('partner-bank-nbfc-disclosure', 'Partner Bank & NBFC Disclosure', '<p>Partner bank and NBFC disclosure content managed by admin.</p>'),
('code-of-conduct-dsa-employees', 'Code of Conduct for DSAs & Employees', '<p>Code of conduct for DSAs and employees content managed by admin.</p>'),
('security-fraud-awareness', 'Security & Fraud Awareness', '<p>Security and fraud awareness content managed by admin.</p>'),
('accessibility-statement', 'Accessibility Statement', '<p>Accessibility statement content managed by admin.</p>')
ON CONFLICT (slug) DO NOTHING;

-- Allow longer future slugs / titles safely
ALTER TABLE legal_pages ALTER COLUMN slug TYPE VARCHAR(128);
ALTER TABLE legal_pages ALTER COLUMN title TYPE VARCHAR(512);
