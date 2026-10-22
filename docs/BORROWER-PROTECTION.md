# Borrower protection: how loan sites hurt people, and what this engine does about it

The brief asks us to match users to loans. A matching engine can still hurt the person it emails, though.
It can push the loan that only *looks* cheapest, stay silent about why someone didn't qualify, or hide the
lenders it didn't show. This document covers three things:

1. **How borrowers actually get hurt** by Indian loan sites, banks and apps, with sources (§1).
2. **What this engine already does** to avoid each harm (§2).
3. **What we would build next and how**, designed down to the files it touches. We ran out of time in the
   72-hour window, so these are documented, not built (§3).

Plain English throughout. Regulatory status is marked on every rule: **in force**, **in force from a date**, or
**draft**. Where a figure comes from a news report rather than the regulator's own text, we say so.

---

## 1. How borrowers get hurt

**Scale.** "Loans and advances" was the **largest complaint category** at the RBI Ombudsman in FY2024-25:
86,670 complaints, 29.25% of the total. Loans are also the majority of complaints against NBFCs
([RBI Ombudsman annual report 2024-25](https://website.rbi.org.in/web/rbi/-/publications/annual-report-of-ombudsman-scheme-2024-25),
summarised by [MediaNama](https://www.medianama.com/2025/12/223-rbi-ombudsman-14-banking-complaints-fy25-private-banks/)).

### H1. The real cost is hidden behind the headline rate

**What happens.** Sites advertise "from 10.5% p.a.". Then a processing fee, documentation charges and
insurance get added, and the fee is usually **deducted from the money you receive**. You get less than you
borrowed but pay interest on the full amount. On short loans, flat rates plus fees push the true yearly cost
(APR) above 50% ([Outlook Business](https://www.outlookbusiness.com/banking/rbi-flags-issue-of-high-rates-on-small-loans-says-hidden-charges-must-be-revealed-in-kfs)).

**Worked example** (₹3,00,000 over 36 months; numbers computed, not quoted):

| Offer | Headline rate | Processing fee | EMI | You receive | Total you pay over the loan (interest + fee) | True yearly cost (APR) |
|---|---|---|---|---|---|---|
| Lender X | **10.5%** | 3.5% (₹10,500) | ₹9,751 | ₹2,89,500 | **₹61,526** | **12.97%** |
| Lender Y | 11.0% | none | ₹9,822 | ₹3,00,000 | ₹53,578 | 11.00% |
| Lender Z | 11.5% | 1% (₹3,000) | ₹9,893 | ₹2,97,000 | ₹59,141 | 12.20% |

The offer with the **lowest headline rate is the most expensive**. A site that sorts by headline rate puts it first.

**The rule.** Since 1 Oct 2024, banks and NBFCs must give every retail and MSME borrower a **Key Facts Statement
(KFS)**. It shows the APR with all charges included (**in force**;
[Outlook Money](https://www.outlookmoney.com/banking/rbi-makes-it-compulsory-for-banks-nbfcs-to-issue-kfs-with-loans-heres-how-it-can-benefit-borrowers)).
In June 2024 the RBI Governor said some lenders still charge fees that aren't in the KFS. The KFS also arrives
**at sanction**, after the borrower has already picked a lender. Comparison has to happen earlier, and that's where we sit.

### H2. Insurance is forced in or added quietly

**What happens.** Loan insurance gets bundled in, sometimes without clear consent, and the premium is financed
inside the loan. Single-premium home-loan cover can't be moved when you shift the loan to another bank
([Business Standard](https://www.business-standard.com/finance/personal-finance/bundled-home-loan-insurance-no-portability-for-single-premium-plans-125032500971_1.html)).
In one case, a consumer commission ordered a bank to refund ₹3.4 lakh of forced insurance with 12% interest
([Tribune](https://m.tribuneindia.com/news/chandigarh/forcing-to-pay-for-insurance-policy-sans-consent-unfair-241942)).

**The rule.** RBI's final rules on mis-selling (issued 15 Jun 2026) ban compulsory bundling and dark patterns, and
require explicit consent (**in force from 1 Jan 2027**; secondary reporting:
[Moneylife](https://moneylife.in/article/rbi-cracks-down-on-misselling-banks-barred-from-forced-bundling-dark-patterns-and-aggressive-sales-tactics/80785.html),
[Vinod Kothari on the draft](https://vinodkothari.com/2026/02/rbis-draft-directions-on-sales-practices/)).

### H3. Terms change after signing

**What happens.** When rates rose, lenders stretched floating-rate loans or raised EMIs **without telling the
borrower**. Some tenures went past 30 years. Charges for closing a loan early (foreclosure or prepayment) can
also wipe out the savings from refinancing.

**The rules.**
- RBI's reset circular (Aug 2023) requires lenders to tell borrowers immediately when EMI or tenure changes,
  and to offer a switch to a fixed rate at each reset (**in force**;
  [Business Standard](https://www.business-standard.com/amp/finance/news/home-loan-borrowers-can-switch-to-fixed-rate-during-reset-says-rbi-123081800748_1.html)).
- The RBI Pre-payment Charges Directions (2 Jul 2025) ban prepayment charges on floating-rate non-business loans to
  individuals (**in force for loans sanctioned or renewed from 1 Jan 2026**;
  [RBI notification](https://www.rbi.org.in/scripts/NotificationUser.aspx?Id=12878)). **Fixed-rate personal loans
  are not covered**, so foreclosure charges on them still matter, and lender pages rarely show them up front.

### H4. Rejections aren't explained, and they cost you

**What happens.** The applicant hears "does not meet our policy" and applies to the next lender, then the next.
Each application is a **hard inquiry** on the credit report. Several in a short time lower the score and look like
money trouble to the next lender, so the next rejection becomes more likely
([Paisabazaar](https://www.paisabazaar.com/credit-score/soft-inquiry-vs-hard-inquiry-aio/)). "Pre-approved" banners
on aggregators make it worse. In one ombudsman case (UK), a "pre-approved" click led straight to a hard check and a decline
([UK Financial Ombudsman](https://www.financial-ombudsman.org.uk/decision/DRN-4259101.pdf)).

**The rule.** RBI's Fair Practices Code (2007) requires lenders to give the main rejection reasons **in writing**,
for every loan size (**in force**;
[RBI](https://website.rbi.org.in/web/rbi/-/notifications/guidelines-on-fair-practices-code-for-lenders-3315)).
It doesn't help before applying: nobody tells you how close you were, or which lender you *would* clear.

### H5. Eligibility rules are a black box

**What happens.** Minimum income, credit score cut-offs, accepted employer types, "work experience" and
location limits are spread over several pages, or left out entirely. Borrowers find out by applying, which takes
them back to H4.

### H6. Aggregators don't show everything, and don't say how they rank

**What happens.** A comparison site can show only the lenders that pay it the most, and present a paid
placement as the "best" match.

**The rule.** The RBI Digital Lending Directions 2025 (8 May 2025) apply to any platform working with several
lenders (**in force from 1 Nov 2025**; [Mondaq](https://www.mondaq.com/india/financial-services/1628380/reserve-bank-of-india-digital-lending-directions-2025),
[AZB & Partners](https://www.azbpartners.com/wp-content/uploads/2025/05/AZB-Update-Digital-Lending-Directions-2025.pdf)).
Such a platform must:
- show **every** matching offer, neutrally and comparably;
- also list **the lenders that didn't match**;
- give lender, amount, tenure, rate, charges and a KFS link for each offer;
- apply its matching logic uniformly to similar borrowers, and document it;
- avoid promotional bias and manipulative interfaces, **unless offers are ranked by a publicly disclosed,
  objective criterion**.

ClickPe is exactly this kind of platform.

### H7. Your data is spread around after you apply

**What happens.** After one application, borrowers report 10+ SMS and 5 calls a day. Sometimes the callers know
the exact amount applied for ([Inventiva](https://www.inventiva.co.in/?p=374065),
[The Ken](https://the-ken.com/kaching/your-credit-bureau-is-likely-leaking-your-loan-data/)). It was raised in
Parliament in Dec 2024 ([Lok Sabha question](https://eparlib.sansad.in/bitstream/123456789/2984735/1/AU1551_6Qek6a.pdf)).
The evidence is anecdotal; there's no regulator finding yet.

### H8. Abusive recovery (mostly illegal apps)

**What happens.** Unregistered instant-loan apps grab the phone's contact list, then message the borrower's
family and colleagues to shame them into paying. In a LocalCircles survey (2020-22, reported second-hand),
54% of instant-loan-app users reported extortion or data misuse during collection, and 58% faced interest of
25% or more ([Al Jazeera](https://www.aljazeera.com/economy/2023/12/25/the-dark-world-of-illegal-loan-apps-in-india),
[Rest of World](https://restofworld.org/2022/digital-blackmail-scammy-loan-apps-india/)).

**The rule.** RBI has draft recovery-conduct directions: Feb 2026, revised May 2026 after heavy feedback. They curb
harassment and contacting relatives or colleagues (**draft**;
[RBI press release](https://www.website.rbi.org.in/web/rbi/-/press-releases/rbi-issues-draft-amendment-directions-for-conduct-of-regulated-entities-in-recovery-of-loans-and-engagement-of-recovery-agents-),
[Business Today](https://www.businesstoday.in/amp/india/story/borrower-first-approach-rbi-proposes-sweeping-norms-to-rein-in-loan-recovery-practices-515961-2026-02-12)).
Recovery happens after disbursal, outside our system. What we can control is which lenders we send people to (§3, idea D).

---

## 2. What the engine already does

| Harm | Already built | Where |
|---|---|---|
| H4 hard inquiries | We never touch a credit bureau: the score comes from the uploaded CSV. The email says up front that viewing matches doesn't affect your credit score. | `email.js` preheader |
| H4/H5 black box | Every card has **"Why you may qualify"**: the user's own numbers held against each published rule ("credit score 742 ≥ 700"). | `email.js` `reasons()` |
| H5 hidden conditions | Rules we can't check (work experience, employer type…) are **never guessed** by the LLM. The match becomes LIKELY, and the card lists the conditions openly under **"Still to confirm with the lender"**. | `matcher.js` stage 3, `email.js` |
| H5 hidden conditions | Workflow D asks the person at most 3 questions, chosen to unlock the most offers, instead of guessing. | `wf_d_confirm.py`, `questions.js`, DESIGN §9.16 |
| H1 made-up numbers | The crawler keeps a number **only if a quote containing it appears verbatim on the lender's page**. Otherwise the field becomes "not stated". An LLM can't invent a rate or cut-off. | `crawl.js` (evidence guard) |
| H4 "pre-approved" bait | Footer: "indicative matches… not loan offers or approvals. Final eligibility, rates and amounts are decided by the lender." | `email.js` |
| H6 one lender hogging the email | `pickCards` spreads cards across lenders, so one lender's variants can't fill the email. | `email.js` `pickCards()` |
| H7 data spread | The LLM sees **bucket ranges** ("income ₹25k–₹40k"), never a person's data. No PII in any URL. Signed unsubscribe link; the suppression list stores a hash, so it survives a DPDP erasure. Consent flag, 7-day cap, and one email per offer set. | `matcher.js` `classFeatures()`, `001_schema.sql`, `c_queue_notifications.sql` |

---

## 3. What we would build next

Each idea plugs into a stage that already exists, rather than adding a new screen next to the product.
They're ordered by **how much they help the borrower per hour of work**, not by how impressive they sound.

### A. Rank and show by true cost, not headline rate (fixes H1, H2, H3)

**Today's gap.** `crawl.js` deliberately **throws away** processing fee and insurance text: `NOT_A_RULE` filters it so it
won't become an eligibility rule. That's correct for eligibility, but the information is then lost. `score()` in
`matcher.js` ranks by `interest_rate_min`, so we sort on exactly the number H1 says misleads.

**Design.**
- **Workflow A: extract the charges.** Add typed fields beside the existing ones:
  - `processing_fee_pct_min/max` and `processing_fee_cap`
  - `foreclosure_fee_pct` and `foreclosure_lock_in_months`
  - `insurance_mandatory` (true / false / null)

  They go through the **same verbatim-evidence guard** and `RANGES` sanity check (e.g. fee 0–10%). `NOT_A_RULE` stays as it is: fees are
  product terms, not applicant rules, so they land in their own columns. Migration: add the columns to `loan_products`
  and add them to `criteria_hash`, so a fee change counts as a criteria change.
- **Workflow B: compute an estimated APR** for a representative loan. Default ₹3,00,000 / 36 months, or the user's
  requested amount once we collect it. Solve for the rate that equates **what you receive** (principal − fee) with the EMI
  stream, using the arithmetic in the table above. It's pure and deterministic: no LLM involved.
- **Ranking rule: missing data must never be an advantage.** If a lender doesn't publish its fee, we rank it as if it
  charged the **highest fee published in the catalogue**, and label it.

  This is the *opposite* of the eligibility default. For eligibility, "not stated" **passes**, so the user sees more
  options. For cost, "not stated" **counts against the lender**; otherwise hiding your fee would buy you the top card.
  Both defaults lean toward the borrower.
- **Workflow C: the card changes.** It shows "Interest 10.5% · fee 3.5% (₹10,500 deducted from what you receive) ·
  ~13.0% true yearly cost on ₹3L / 3 yrs". When the lender doesn't publish its fee: "Fee not published — ask
  for the Key Facts Statement before you sign; its APR is the number to compare." Also "Insurance optional"
  when the page says so, and a "Foreclosure charge 4%" warning on fixed-rate products.

**Tests.** Unit tests for the APR solver against the table above. A differential test where a cheaper-looking but costlier
product must rank below the honest one. Evidence-guard tests for fee fields with fabricated quotes. Re-run the extractor
on all 15 lenders' live pages and record which publish fees. **That re-validation is the reason this wasn't built in
the time box.**

### B. "Close, but not yet": explain non-matches (fixes H4, H5)

**Today's gap.** A user with **zero matches gets nothing**: `c_queue_notifications.sql` only picks users with
new rows in `matches`. They're left to discover the cut-offs by applying, which burns hard inquiries (H4).
DESIGN §9.9's sample email already pictured the line "If your credit score reaches 750, 2 more lenders become
available"; it was never built.

**Design.** The matcher already has one bitmask per attribute (`inc`, `cred`, `age`, `job`). The products a class fails
on **exactly one** attribute fall out of the same operation, almost for free:

```
others_a  = AND of the other three masks
nearMiss_a = others_a & ~mask_a          // passes everything except attribute a
```

- **Cost.** Three extra ANDs per class: still O(classes × attributes), and no per-user work.
- **Storage.** A `near_misses (user_id, product_id, failed_on, batch_id)` table. We keep it out of `matches`, which the brief
  defines as eligible pairs, and whose partial index drives notifications.
- **Only actionable gaps.** Credit score within 50 points, or income within 20%, is worth showing. Employment type isn't,
  because "change your job" isn't advice. Age only as "you'll qualify at 21".
- **Email.** A "Close, but not yet" section, e.g. "Axis needs ₹25,000/month; you're at ₹22,000." The gap is computed at
  render time from the user's real values. The class only holds bucket ranges.
- **Zero-match users finally get an email.** It says what's blocking them and that applying blind would add hard
  inquiries without changing the answer. Same consent check, suppression list and 7-day cap; a distinct `digest_key` so it
  can't collide with an offer email.
- **The honest version of credit advice.** Pay on time, keep card use low, check the report for errors and dispute them.
  No "credit repair" upsell.

**Malicious-actor angle (the whiteboard question).** Telling someone "you're ₹3,000 short" invites them to declare a higher
income in Workflow D. Mitigations:
- The near-miss copy never suggests re-declaring.
- Declared answers that contradict each other or the CSV are already flagged for ops and **never used**
  (`user_declarations.flagged`, `confirm.js`).
- Workflow D can't change income or credit score at all. It only asks about data the CSV doesn't hold: work experience,
  employer type, bank relationship, city, business vintage, existing EMIs (`questions.js`).
- The lender verifies documents anyway; the harm we're guarding against is the user wasting an application.

### C. Show our work: unmatched lenders, ranking rule, freshness (fixes H6)

**Today's gap.** The email lists matches only. It doesn't say which lenders we checked and *didn't* match, how cards are
ordered, or how fresh the criteria are. The 2025 Digital Lending Directions require the first two of a multi-lender platform.

**Design.** This is all in Workflow C; the data already exists.
- `c_load_pending.sql` adds `p.last_seen_at`, plus one query for the distinct active lenders in `loan_products`.
- Footer: "We checked 15 lenders. Not matched for your profile: SBI, HSBC, …".
- One sentence on ranking that matches the code exactly. Today: "ordered by lowest published interest rate; each
  condition still to confirm lowers an offer slightly". After A: "by estimated true yearly cost".
- Each card: "Criteria as published on {lender}'s site, checked {date}", linking to the source page we crawled.
- A test asserting the ranking sentence and `score()` agree, so the disclosure can't silently drift from the code.

### D. Only send people to lenders that are allowed to lend (fixes H7, H8)

Illegal apps are where the worst harms in H8 happen. Our catalogue is seeded by hand with banks and RBI-registered NBFCs
(`002_seed_crawl_sources.sql`, `006_more_lenders.sql`). If sources ever become discovered rather than curated, add a check
against RBI's public list of registered NBFCs and its directory of reported digital lending apps (Digital Lending
Directions 2025), and show "RBI-registered NBFC" on the card, as DESIGN §9.9 sketches. Small cost, large protection.

### What we'd deliberately **not** build

- **EMI affordability verdicts** ("you can afford ₹X"). We only know existing EMIs for people who answered Workflow D's
  `existing_emi` question, and even then it's self-declared. A confident wrong number is worse than none. It comes
  back if consented Account Aggregator data is added.
- **LLM-estimated fees or APRs** where the page is silent. That would reintroduce the hallucination risk the evidence
  guard exists to remove. Silence is shown as silence (idea A).
- **Scraped review scores.** They're easy to game and hard to attribute, and a ranking input we can't defend is an H6 problem of our own.

---

## 4. Questions to expect at the whiteboard

- **"Why not just sort by interest rate? That's what users search for."** See the H1 table: the lowest-rate offer
  costs ₹8,000 more. Sorting by headline rate rewards lenders for moving cost into fees.
- **"Isn't penalising unpublished fees unfair to those lenders?"** It's disclosed, and it reverses the moment they
  publish. The alternative rewards opacity, and the Digital Lending Directions want an objective, disclosed ranking criterion.
- **"Why default 'not stated' to pass for eligibility, but to the worst case for cost?"** Each default is chosen to
  favour the borrower. A false "eligible" costs one wasted click, and the card says it's indicative. A falsely cheap
  ranking costs real money.
- **"Doesn't the near-miss email just teach people to lie?"** See the malicious-actor note in B. Income and score aren't
  self-declarable, and the copy never suggests re-declaring.
- **"Where does this break?"**
  - Fee extraction depends on lenders publishing fees in page text. Many don't: they get labelled, not guessed.
  - The representative-loan APR is an estimate, and the card says so.
  - Near misses inherit the crawl's freshness, so a lender can change a cut-off between crawls. The "checked on" date is shown.
