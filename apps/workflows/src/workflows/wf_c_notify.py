"""Workflow C — User Notification (runs after workflow B, via Execute Workflow).

Called by B ─► Claim batch ─► Queue notifications ─► Load pending ─► Render emails ─► Any email? ─yes─► Loop ─► SES send ─ok─► Mark sent ─┐
             (CAS MATCHED→     (consent, suppression,                (personalised)              │      ▲          └err─► Mark failed ┤
              NOTIFYING)        7-day cap, test-mode alias,                                     │      └──── Throttle 1 s ◄──────────┘
                                UNIQUE digest = no duplicates)                                   └no / loop done ─► Finish (counts, DONE)
"""

from .nodes import CREDENTIALS, Workflow, include


def build() -> dict:
    w = Workflow("C", "C · Notify matched users")
    w.add("Called by workflow B", "n8n-nodes-base.executeWorkflowTrigger", 1.1, {"inputSource": "passthrough"}, (0, 100))
    w.postgres("Claim batch", "c_claim_batch", (220, 100), params_expr="={{ [$json.batch_id] }}")
    w.postgres("Queue notifications", "c_queue_notifications", (440, 100), params_expr=(
        "={{ [$('Claim batch').first().json.batch_id, String($env.TEST_MODE ?? 'true'), "
        "JSON.stringify(String($env.TEST_RECIPIENTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)), "
        "String($env.MAX_EMAILS_PER_RUN ?? '5')] }}"))
    w.postgres("Load pending", "c_load_pending", (660, 100),
               params_expr="={{ [$('Claim batch').first().json.batch_id] }}", alwaysOutputData=True)
    w.code("Render emails", include("email") + """
// One personalised email per pending notification (HTML-escaped, Indian number format, the
// user's own numbers held against each lender's rules, unverifiable conditions shown honestly).
const now = Math.floor(Date.now() / 1000);
const opts = { unsubscribeBase: $env.UNSUBSCRIBE_BASE_URL, secret: $env.UNSUBSCRIBE_SECRET, now, maxCards: 3 };
const out = [];
for (const item of $input.all()) {
  const n = item.json;
  if (!n.notification_id || !Array.isArray(n.products) || !n.products.length) continue;
  const { subject, html, text } = email.renderEmail(n, opts);
  out.push({ json: { notification_id: n.notification_id, recipient: n.recipient, subject, html, text, send: true } });
}
// Always emit something so the workflow can close the batch even when nobody needs an email.
return out.length ? out : [{ json: { send: false } }];
""", (880, 100))
    w.add("Any email?", "n8n-nodes-base.if", 2.2, {
        "conditions": {
            "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
            "conditions": [{"id": "6a1f2c3e-0b1d-4c8e-9f00-00000000c0a1", "leftValue": "={{ $json.send }}",
                            "rightValue": "", "operator": {"type": "boolean", "operation": "true", "singleValue": True}}],
            "combinator": "and"},
        "options": {}}, (1100, 100))
    w.add("Loop one at a time", "n8n-nodes-base.splitInBatches", 3, {"batchSize": 1, "options": {}}, (1320, 0))
    w.add("Send via SES", "n8n-nodes-base.awsSes", 1, {
        "operation": "send", "isBodyHtml": True,
        "subject": "={{ $json.subject }}", "body": "={{ $json.html }}",
        "fromEmail": "={{ $env.SES_FROM_EMAIL }}", "toAddresses": ["={{ $json.recipient }}"],
        "additionalFields": {}},
        (1540, -60), credentials={"aws": CREDENTIALS["aws"]},
        retryOnFail=True, maxTries=3, waitBetweenTries=2000, onError="continueErrorOutput")
    w.postgres("Mark sent", "c_mark_sent", (1760, -140), alwaysOutputData=True, params_expr=(
        "={{ [String($('Loop one at a time').item.json.notification_id), "
        "String($json.SendEmailResponse?.SendEmailResult?.MessageId ?? $json.MessageId ?? ('unknown:' + Object.keys($json).join('|')))] }}"))
    w.postgres("Mark failed", "c_mark_failed", (1760, 40), alwaysOutputData=True, params_expr=(
        "={{ [String($('Loop one at a time').item.json.notification_id), "
        "String($json.error?.message ?? $json.error ?? 'SES error')] }}"))
    # SES sandbox allows 1 email/second; this keeps us under it (a shared token bucket at Tier 2).
    w.add("Throttle 1 s", "n8n-nodes-base.wait", 1.1, {"amount": 1, "unit": "seconds"}, (1980, -60),
          webhookId="b1e7c0de-0000-4000-8000-00000000c001")
    w.postgres("Finish", "c_finish", (1540, 220), executeOnce=True,
               params_expr="={{ [$('Claim batch').first().json.batch_id] }}")

    w.chain("Called by workflow B", "Claim batch", "Queue notifications", "Load pending", "Render emails", "Any email?")
    w.connect("Any email?", "Loop one at a time", 0)
    w.connect("Any email?", "Finish", 1)
    w.connect("Loop one at a time", "Finish", 0)          # output 0 = done
    w.connect("Loop one at a time", "Send via SES", 1)    # output 1 = next item
    w.connect("Send via SES", "Mark sent", 0)
    w.connect("Send via SES", "Mark failed", 1)           # error output
    w.connect("Mark sent", "Throttle 1 s")
    w.connect("Mark failed", "Throttle 1 s")
    w.connect("Throttle 1 s", "Loop one at a time")
    return w.to_json()
