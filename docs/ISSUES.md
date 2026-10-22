# Issues we hit while building, and how we fixed them

Each entry follows the same pattern: **what you saw**, **what was really going on**, **how we fixed it**, and **the lesson**.
No prior knowledge needed. A short glossary is at the bottom.

---

## 1. Uploads sat in "Queued for matching" for about 2 minutes

**What you saw.** The upload finished in about 2 seconds, then the status sat on *Queued for matching* for roughly
2 minutes before matching started. Once matching started, it was done in about 1 second.

**How it's supposed to work.** There are two ways matching can start:

1. **The doorbell (fast path).** As soon as the users are saved, the AWS Lambda calls n8n's webhook, as if
   ringing a doorbell: "batch ready, start matching." Matching starts within about a second.
2. **The sweeper (backup).** Every 2 minutes, n8n looks for uploads that are saved but not yet matched. This exists so
   a missed doorbell can never lose an upload. It only makes it later.

A 2-minute wait means the doorbell failed and the backup picked the upload up. The activity log said so:
*Queued for matching* (the doorbell failed) instead of *Matching triggered* (it worked).

**What was really going on.** n8n runs on a laptop, and AWS reaches it through a free Cloudflare "quick tunnel":
a temporary public web address like `https://some-random-words.trycloudflare.com`. **The tunnel gets a new random
address every time it restarts.** The deploy script reads the new address from the tunnel's log and gives it to the Lambda.

The bug: when Docker restarts an existing container, **the container keeps its old log lines**. The script searched
the log, found the address from the *previous* run first, and gave the Lambda that dead address. The Lambda's
error log showed it:

```
doorbell failed ... lookup equipment-band-four-against.trycloudflare.com: no such host
```

The live tunnel was actually at `signs-tries-nuts-collection.trycloudflare.com`. Every upload was ringing a doorbell
on a house that no longer existed.

**How we fixed it.** `scripts/deploy_all.sh` now *recreates* the tunnel container instead of restarting it
(`docker compose up -d --force-recreate cloudflared`). A brand-new container has a brand-new log, so the only address
in it is the current one.

**Then we removed the root cause.** The fix above stops the script reading a stale address, but a random address still
goes stale whenever the laptop or Docker restarts. So we moved to **ngrok**, whose free plan includes one
**permanent** address (ours: `uninvigorating-unlevelly-missy.ngrok-free.dev`; ngrok picks the name, not us).
Set `NGROK_AUTHTOKEN` and `NGROK_DOMAIN` in `.env`, and `deploy_all.sh` uses that fixed address, checks that it really
reaches n8n, and gives it to the Lambda **once**. After a reboot you just start the tunnel again
(`docker compose --profile ngrok up -d`). No redeploy, and no stale address. Without those two settings, the script
falls back to the Cloudflare quick tunnel as before.

Only the tunnel changed. Everything on AWS (console, API, Lambdas, database, emails) and n8n itself stayed the same.

**The lesson.** The design worked as intended: nothing was lost, the backup did its job, and the activity log
pointed at the cause. The bug was in deploy tooling, not in the pipeline. The real cure was to stop depending on an
address that changes. In production, n8n would be hosted at a fixed URL rather than on a laptop.

---

## 2. Uploaded a file and everything said 0, and no email came

**What you saw.** The upload page showed *0 matches, 0 emails* for every number, and nothing arrived in the inbox.

**What was really going on.** The same CSV had been uploaded **twice**:

| Upload | New users | Matches | Emails |
|---|---|---|---|
| First | 50 | 41 | 3 sent |
| Second (identical file) | 0 new, 0 changed | 0 | 0 |

The system saves users by their `user_id`. The second time, every row matched someone already saved with
exactly the same details, so nobody new needed matching. The system also **never emails the same person twice
for the same offer** (and at most once a week). So 0 was the correct answer. The emails had already gone out
from the first upload.

**How we fixed it.** Nothing was wrong with the behaviour, but a page full of zeros looks broken. The upload page now
says so in plain words: *"Every valid row matched a user already on file with identical details, so there was
nothing new to match or email."* To test again, generate a file with new users:

```bash
.venv/bin/python scripts/make_demo_csv.py 50 > data/demo_users_fresh.csv
```

**The lesson.** "Idempotent" (doing the same thing twice has the same effect as once) is what protects users from spam,
but the UI has to explain it, or it looks like a failure.

---

## 3. Only 3 lenders, so matches were narrow

**What you saw.** The catalogue had only HDFC, ICICI and Kotak, so most people matched only a few products.

**What was really going on.** The list of pages to crawl is just rows in a database table (`crawl_sources`), and only
3 lenders had been added. Adding more is a data change, not a code change. The hard part is finding pages that
actually work:

- Many Indian banks moved from `.com` to `.bank.in` addresses in 2025–26, so old links return 404.
- Some sites only fill in their text with JavaScript after the page loads. Our crawler reads the HTML the server
  sends, so it sees an empty page (PNB, Yes Bank, Federal Bank, Standard Chartered, Canara).
- Some block automated visitors outright (AU Bank, Muthoot return 403 Forbidden).

**How we fixed it.** We tested about 50 candidate pages, then ran each good one through the *real* extractor (the same
code and AI model as production) and kept only lenders where at least one product came out with every number backed by
a word-for-word quote from the page. That gave 12 new lenders, 15 in total:
SBI, Axis, Bank of Baroda, Union Bank, IDFC FIRST, IndusInd, RBL, HSBC, Bajaj Finserv, Tata Capital,
Poonawalla Fincorp and L&T Finance. They live in `packages/database/migrations/006_more_lenders.sql`.

Two related improvements:

- **Emails now show a spread of lenders.** Before, the email showed the top 3 products by score, which could all be
  the same bank (e.g. "HDFC – Salaried" and "HDFC – Self-Employed"). Now it takes each lender's best product
  first, shows up to 5, and says "+N more across X lenders".
- **The crawler paces its AI calls.** With 15 lenders it would have sent 15 AI requests at the same moment and hit the
  provider's per-minute limit. It now sends 4 at a time with a 2-second pause between groups.

**The lesson.** Before adding a source, check that it actually returns usable text. "The URL loads in my browser"
isn't proof, because your browser runs JavaScript and the crawler doesn't.

---

## 4. Some lenders occasionally come back with no products

**What you saw.** After a crawl, 13 of 15 lenders had products. IDFC FIRST and Tata Capital had none.

**What was really going on.** The AI provider (Gemini) took longer than our 90-second limit to answer for those two.
Re-running the same request a minute later worked in about 16 seconds. It's temporary slowness on their side.

**How it's handled.** The crawler retries each AI call up to 3 times. If it still fails, it **keeps yesterday's
products** instead of wiping them, and it forgets that page's saved state so the next crawl tries it again instead of
skipping it as "unchanged". No manual action needed.

**The lesson.** Any outside service will sometimes be slow. The rule is: a failure must never delete good data,
and it must retry itself.

---

## 5. Most matches said "to confirm", even for simple products

**What you saw.** On `users.csv`, only 18,614 of 93,031 matches were *eligible*. Almost everything else was
*likely, still to confirm*, and the email's "still to confirm" list was full of lines like *"loan amount varies by
location"* or *"insurance is mandatory"*. Those aren't things a person has to prove.

**What was really going on.** For each product the AI also writes down "soft rules": requirements the typed fields
(income, credit score, age, employment) can't hold, like "2 years of work experience". A match with any soft rule we
can't check becomes *to confirm*. The AI was putting notes about the **loan**, not the **applicant**, into that list:

| Written as a rule | Why it isn't one |
|---|---|
| "Loan amount varies by location", "property ownership affects eligibility" | Describes the loan amount, not who can apply |
| "Insurance is mandatory" | A product term |
| "Must be an Indian resident" | Every applicant already is |
| "Steady income", "meet minimum salary requirements" | A vague restatement of the income field, with no number |
| "A score of 700 is ideal" | A preference, not a requirement |

One bad line was enough to push a whole product into *to confirm* for everyone. Once, the AI even put a Russian word
in the middle of an English rule.

**How we fixed it.** Three changes, all in Workflow A:

1. **The prompt now says what a rule is** (`extract-v4` in `apps/workflows/src/code/llm.js`): a requirement the
   applicant must meet, and an explicit list of things that are not rules (amounts, fees, insurance, documents,
   preferences, residency, vague restatements).
2. **A plain-code safety net**, `isApplicantRule()` in `apps/workflows/src/code/crawl.js`. It drops anything that
   matches the "not a rule" patterns, and any rule containing a non-Latin letter that doesn't appear on the page.
   It doesn't depend on the AI behaving.
3. **The page hash now includes the prompt version.** The crawler skips the AI when a page's text hash is unchanged.
   Now a new prompt version changes the hash, so every page is re-read with the new prompt. One catch: a
   *304 Not Modified* from the bank still stops before the hash, so for this release we cleared the saved crawl
   state once by hand.

**Result on `users.csv`.**

| | Before | After |
|---|---|---|
| Eligible matches (of 93,031) | 18,614 | 36,068 |

7 products now have eligible people. The *to confirm* matches left are real requirements we don't have data for: being an existing customer (RBL, HSBC),
work experience (HDFC, ICICI, IndusInd, Poonawalla, Kotak) and employer type. Those are what the confirmation flow
(Workflow D) asks about.

**The lesson.** An AI-extracted field that changes a decision needs a definition in the prompt **and** a check in
code. And a cache keyed on the input must also be keyed on the prompt, or a better prompt never runs.

---

## 6. The AI judge read "2 years" as "exactly 2 years"

**What you saw.** In the first live test of the confirmation form, a person said they had 15 years of work
experience. HDFC, Poonawalla and Bank of Baroda moved to pre-qualified, but ICICI was *removed* as "doesn't fit".

**What was really going on.** ICICI's page says "Total years of work experience: 2 years". The AI judge
read that literally: "the rule requires exactly 2 years, but the profile states 15", so it answered FAIL.
We found it by reading the judge's reasons in the n8n execution log.

**How we fixed it.** The judge's instructions now say that a number in an eligibility rule is a **minimum**
unless the text says it is a maximum ("up to", "or younger"). Re-checked against the real model: 15 years
passes, 1 year fails, and "80 years or younger" still works as a maximum. We re-matched the batch, which
brought the ICICI offer back as "to confirm", and the same answers then confirmed it. Separately, a
re-match no longer overwrites matches that a person has already confirmed.

**The lesson.** Read the AI's *reasons*, not just its verdicts. One wrong reason exposed an ambiguity
that would have quietly removed good offers for many people.

---

## 7. Earlier setup issues (short list)

| Issue | Cause | Fix |
|---|---|---|
| AWS Bedrock AI said "Operation not allowed", even as the account owner | New AWS accounts get a quota of 0 for these models, and it can't be raised from the console | Use Gemini through its OpenAI-compatible address. The code works with any provider by changing `LLM_BASE_URL`/`LLM_MODEL` |
| Gemini `2.5-flash-lite` refused requests | Google retired it for new users | Switched to `gemini-3.5-flash-lite` |
| `brew install awscli` crashed on this Mac | A library clash inside Homebrew's Python | Installed the official AWS CLI into the home folder (`~/aws-cli`) |
| Serverless deploy couldn't find AWS credentials after `aws login` | Serverless v3 doesn't understand the new login sessions | The deploy script exports short-lived credentials just before deploying |
| CloudFront (the CDN) wouldn't create | AWS hadn't verified the new account for CloudFront yet | Host the console on AWS Amplify instead (HTTPS, short URL). The CDN switch stays available: `CDN=true` |
| n8n read empty page bodies | In n8n 2.x the "full response" puts the page text in `.data`, not `.body` | The crawler reads `.data` (and falls back to `.body`) |

---

## How to debug the next one

1. **Open the upload's Activity list in the console.** Every stage writes an event. A gap or an unexpected status
   (e.g. *Queued for matching* instead of *Matching triggered*) tells you which stage to look at.
2. **Look at the logs for that stage.** Ingest/doorbell: CloudWatch log group `/aws/lambda/loan-engine-dev-ingest`.
   Matching/emails: the n8n UI → Executions.
3. **Check the database.** `ingest_batches` (row counts), `pipeline_events` (the timeline), `crawl_runs`
   (why a lender failed).

## Glossary

- **Lambda.** A small piece of code AWS runs on demand. Ours read the uploaded CSV and save users.
- **n8n.** A visual workflow tool. Ours crawls lenders, matches users and sends emails.
- **Webhook / doorbell.** A web address one system calls to tell another "something happened, act now."
- **Tunnel.** A temporary public web address that forwards to a program on a laptop, so AWS can reach n8n.
- **Sweeper.** A timer job that finds anything the fast path missed.
- **Migration.** A numbered SQL file that changes the database. They run in order, and each runs only once.
- **Idempotent.** Doing it twice has the same effect as doing it once.
