-- Broaden the catalogue from 3 lenders to 15: public & private banks, a foreign bank and NBFCs.
-- Every URL was checked to serve its eligibility/rate text as server-rendered HTML (no JS needed)
-- and run through the production extractor (windowing → LLM → verbatim-evidence validation)
-- with at least one product surviving. Lenders whose single product page carries both
-- eligibility and rates get one row; Group by lender treats it the same as a page pair.
INSERT INTO crawl_sources (url, lender_name, page_role) VALUES
  ('https://sbi.bank.in/web/personal-banking/loans/personal-loans', 'State Bank of India', 'eligibility'),
  ('https://www.axis.bank.in/loans/personal-loan', 'Axis Bank', 'eligibility'),
  ('https://www.axis.bank.in/loans/personal-loan/interest-rates-charges', 'Axis Bank', 'rates'),
  ('https://bankofbaroda.bank.in/loans/personal-loan', 'Bank of Baroda', 'eligibility'),
  ('https://www.unionbankofindia.bank.in/en/details/personal-loan', 'Union Bank of India', 'eligibility'),
  ('https://www.idfcfirst.bank.in/personal-banking/loans/personal-loan', 'IDFC FIRST Bank', 'eligibility'),
  ('https://www.indusind.bank.in/in/en/personal/loans/personal-loan.html', 'IndusInd Bank', 'eligibility'),
  ('https://www.rbl.bank.in/personal-banking/loans/personal-loan', 'RBL Bank', 'eligibility'),
  ('https://www.hsbc.bank.in/loans/products/personal/', 'HSBC India', 'eligibility'),
  ('https://www.bajajfinserv.in/personal-loan-eligibility-calculator', 'Bajaj Finserv', 'eligibility'),
  ('https://www.bajajfinserv.in/personal-loan', 'Bajaj Finserv', 'rates'),
  ('https://www.tatacapital.com/personal-loan.html', 'Tata Capital', 'eligibility'),
  ('https://poonawallafincorp.com/personal-loan', 'Poonawalla Fincorp', 'eligibility'),
  ('https://www.ltfinance.com/personal-loan', 'L&T Finance', 'eligibility')
ON CONFLICT (url) DO NOTHING;
