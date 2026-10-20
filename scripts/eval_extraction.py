"""Score the real LLM's product extraction against the golden answers (tests/fixtures/llm/*.json).

    set -a; source .env; set +a; python scripts/eval_extraction.py

Runs the production path — crawler text windowing, the extraction prompt, the evidence validator —
on the saved page snapshots, then reports per-field exact-match accuracy and tokens used.
Target (docs/DESIGN.md §12): ≥ 95% of numeric facts exact; anything unsupported is dropped, not stored.
"""

import gzip
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIX = ROOT / "tests/fixtures"
RUNNER = ROOT / "apps/workflows/tests/run_module.js"
LENDERS = {"HDFC Bank": ("hdfc", "hdfc_rates"), "ICICI Bank": ("icici", "icici_rates"),
           "Kotak Mahindra Bank": ("kotak", "kotak_rates")}
FIELDS = ("interest_rate_min", "interest_rate_max", "min_monthly_income", "min_credit_score", "min_age", "max_age")


def js(module, fn, *args):
    out = subprocess.run(["node", str(RUNNER), module, fn], input=json.dumps(args), capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def llm(body):
    req = urllib.request.Request(os.environ["LLM_BASE_URL"].rstrip("/") + "/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {os.environ['LLM_API_KEY']}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def key(p):  # match products by who they're for, not by exact wording of the name
    return tuple(sorted(p.get("employment_types") or ["any"]))


def main():
    model = os.environ["LLM_MODEL"]
    hits = total = tokens = dropped = 0
    for lender, pages in LENDERS.items():
        urls = [f"https://{p}" for p in pages]
        sections = [js("crawl", "relevantSection", js("crawl", "htmlToText", gzip.decompress((FIX / "html" / f"{p}.html.gz").read_bytes()).decode()))
                    for p in pages]
        request = js("llm", "extractionRequest", model, lender,
                     [{"role": r, "url": u, "text": t} for r, u, t in zip(("eligibility", "rates"), urls, sections, strict=True)])
        response = llm(request)
        tokens += js("llm", "tokensUsed", response)
        parsed = js("llm", "parseJsonContent", response)
        got = js("crawl", "validateProducts", parsed, {"lender": lender, "sourceText": "\n".join(sections), "sourceUrl": urls[0]})
        dropped += len(got["warnings"])
        golden = json.loads((FIX / "llm" / f"{pages[0]}.json").read_text())["products"]
        by_key = {key(p): p for p in got["products"]}
        print(f"\n{lender}: {len(got['products'])} product(s); {len(got['warnings'])} unsupported claim(s) dropped")
        for w in got["warnings"]:
            print(f"   dropped: {w}")
        for g in golden:
            p = by_key.get(key(g), {})
            for f in FIELDS:
                if g.get(f) is None:
                    continue
                total += 1
                ok = p.get(f) is not None and abs(float(p[f]) - float(g[f])) < 1e-6
                hits += ok
                print(f"   {'✓' if ok else '✗'} {g['product_name']:<32} {f:<20} expected {g[f]!s:<8} got {p.get(f)}")
    print(f"\nnumeric exact match: {hits}/{total} = {hits / max(total, 1):.0%}   tokens: {tokens}   dropped: {dropped}")
    sys.exit(0 if hits / max(total, 1) >= 0.95 else 1)


if __name__ == "__main__":
    main()
