-- The pages workflow A crawls daily. Data, not code: add a lender by inserting rows.
-- Each lender = an eligibility page + a rates page (eligibility pages rarely state rates).
-- Note: Indian banks moved from *.com to *.bank.in in 2025-26; the crawler follows redirects,
-- so old URLs keep working, but we store the canonical ones.
INSERT INTO crawl_sources (url, lender_name, page_role) VALUES
  ('https://www.hdfc.bank.in/personal-loan/eligibility-criteria', 'HDFC Bank', 'eligibility'),
  ('https://www.hdfc.bank.in/personal-loan', 'HDFC Bank', 'rates'),
  ('https://www.icici.bank.in/personal-banking/loans/personal-loan/eligibility', 'ICICI Bank', 'eligibility'),
  ('https://www.icici.bank.in/personal-banking/loans/personal-loan/personal-loan-interest-rates', 'ICICI Bank', 'rates'),
  ('https://www.kotak.bank.in/en/personal-banking/loans/personal-loan/eligibility.html', 'Kotak Mahindra Bank', 'eligibility'),
  ('https://www.kotak.bank.in/en/personal-banking/loans/personal-loan/interest-rates.html', 'Kotak Mahindra Bank', 'rates')
ON CONFLICT (url) DO NOTHING;
