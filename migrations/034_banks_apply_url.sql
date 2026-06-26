-- External application/website link for each bank (used by marketplace + dashboard apply links)

ALTER TABLE banks
  ADD COLUMN apply_url TEXT NULL AFTER certifications;
