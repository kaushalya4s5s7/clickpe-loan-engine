"""Post-deploy smoke test against the REAL stack — checks what local fakes can't.

    API_URL=https://<id>.execute-api.ap-south-1.amazonaws.com/dev API_KEY=... python scripts/smoke_aws.py data/users.csv

1. S3 rejects a part whose bytes don't match the signed SHA-256 (moto doesn't enforce this).
2. A real upload completes, S3 → SQS → Lambda ingests it, and the batch reaches LOADED or beyond.
"""

import base64
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

API, KEY = os.environ["API_URL"].rstrip("/"), os.environ["API_KEY"]


def call(method, path, body=None):
    req = urllib.request.Request(f"{API}{path}", method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"Content-Type": "application/json", "X-Api-Key": KEY})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"null")


def put(url, data, headers):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, method="PUT", headers=headers), timeout=60) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def sha(b):
    return base64.b64encode(hashlib.sha256(b).digest()).decode()


with open(sys.argv[1], "rb") as f:
    data = f.read()
s = call("POST", "/v1/uploads", {"filename": "smoke.csv", "size_bytes": len(data)})
print("session", s)
chunk = data[: s["part_size"]]
[u] = call("POST", f"/v1/uploads/{s['batch_id']}/part-urls", {"parts": [{"part_number": 1, "sha256": sha(chunk)}]})["urls"]
tampered = put(u["url"], chunk[:-1] + b"#", u["headers"])
print("tampered part →", tampered, "(expect 400)")
assert tampered == 400, "S3 must reject bytes that don't match the signed checksum"

for n in range(1, s["part_count"] + 1):
    part = data[(n - 1) * s["part_size"]: n * s["part_size"]]
    [u] = call("POST", f"/v1/uploads/{s['batch_id']}/part-urls", {"parts": [{"part_number": n, "sha256": sha(part)}]})["urls"]
    assert put(u["url"], part, u["headers"]) == 200
print("complete", call("POST", f"/v1/uploads/{s['batch_id']}/complete"))
for _ in range(60):
    st = call("GET", f"/v1/batches/{s['batch_id']}")["batch"]
    print(" status", st["status"], st["rows_valid"], st["rows_rejected"])
    if st["status"] not in ("CREATED", "UPLOADED", "PARSING"):
        break
    time.sleep(3)
assert st["status"] in ("LOADED", "MATCHING", "MATCHED", "NOTIFYING", "DONE"), st
print("OK")
