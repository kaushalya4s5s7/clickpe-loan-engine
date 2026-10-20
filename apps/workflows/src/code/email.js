// Workflow C helpers: personalised, honest, mobile-first email + the unsubscribe token.
//
// Content rules (docs/DESIGN.md §9.9): lender named on every card, rate exactly as published,
// "why you qualify" from the user's own data, unverifiable conditions shown openly, no PII in
// links, HTML escaped (names come from a spreadsheet), plain-text twin, well under Gmail's
// ~102 KB clipping limit.

const crypto = require("crypto");

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Identical to packages/notifications (Go); a contract test checks both. */
function unsubscribeToken(userId, secret, nowSeconds, ttlSeconds = 90 * 24 * 3600) {
  const payload = `${b64url(Buffer.from(String(userId), "utf8"))}.${nowSeconds + ttlSeconds}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest().subarray(0, 16);
  return `${payload}.${b64url(sig)}`;
}

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Indian digit grouping without relying on ICU: 150000 → "1,50,000". */
function formatINR(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return "";
  const s = String(Math.abs(n));
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return (n < 0 ? "-" : "") + "₹" + (rest ? `${rest},${last3}` : last3);
}

function rateText(p) {
  const lo = p.interest_rate_min, hi = p.interest_rate_max;
  if (lo == null) return "Rate: see lender website";
  return lo === hi || hi == null ? `Interest from ${Number(lo)}% p.a.` : `Interest ${Number(lo)}–${Number(hi)}% p.a.`;
}

/** The user's own data, held against each published rule — the "why" behind the match. */
function reasons(user, p) {
  const r = [];
  if (p.min_monthly_income != null) r.push(`income ${formatINR(user.monthly_income)}/month ≥ ${formatINR(p.min_monthly_income)} minimum`);
  if (p.min_credit_score != null && user.credit_score != null) r.push(`credit score ${user.credit_score} ≥ ${p.min_credit_score}`);
  if (p.min_age != null || p.max_age != null) r.push(`age ${user.age} within ${p.min_age ?? "–"}–${p.max_age ?? "–"}`);
  if (Array.isArray(p.employment_types) && p.employment_types.length) r.push(`${user.employment_status} applicants accepted`);
  return r;
}

const firstName = (name) => String(name ?? "").trim().split(/\s+/)[0] || "there";

/**
 * @param n  {user_id, name, monthly_income, credit_score, employment_status, age, products:[...]}
 * @param o  {unsubscribeBase, secret, now (seconds), maxCards}
 */
function renderEmail(n, o) {
  const products = (n.products || []).slice(0, o.maxCards ?? 3);
  const more = (n.products || []).length - products.length;
  const name = firstName(n.name);
  const token = unsubscribeToken(n.user_id, o.secret, o.now);
  const unsubscribeUrl = `${o.unsubscribeBase}?t=${encodeURIComponent(token)}`;
  const count = (n.products || []).length;
  const subject = `${name}, ${count} personal loan${count === 1 ? "" : "s"} you may qualify for`;

  const cards = products.map((p) => {
    const why = reasons(n, p).map((r) => `<li>${escapeHtml(r)}</li>`).join("");
    const todo = (p.unverified || []).map((u) => `<li>${escapeHtml(u)}</li>`).join("");
    return `<tr><td style="padding:16px;border:1px solid #e4e4e7;border-radius:12px;background:#ffffff">
<div style="font-size:12px;color:#71717a;text-transform:uppercase;letter-spacing:.04em">${escapeHtml(p.lender_name)}</div>
<div style="font-size:18px;font-weight:700;color:#18181b;margin:2px 0 6px">${escapeHtml(p.product_name)}</div>
<div style="font-size:15px;color:#18181b">${escapeHtml(rateText(p))}${p.max_loan_amount ? ` · up to ${formatINR(p.max_loan_amount)}` : ""}</div>
${why ? `<div style="margin-top:10px;font-size:14px;color:#15803d;font-weight:600">Why you may qualify</div><ul style="margin:4px 0 0;padding-left:18px;font-size:14px;color:#3f3f46">${why}</ul>` : ""}
${todo ? `<div style="margin-top:10px;font-size:14px;color:#a16207;font-weight:600">Still to confirm with the lender</div><ul style="margin:4px 0 0;padding-left:18px;font-size:14px;color:#3f3f46">${todo}</ul>` : ""}
<div style="margin-top:14px"><a href="${escapeHtml(p.source_url)}" style="display:inline-block;background:#4338ca;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px;font-weight:600">View on ${escapeHtml(p.lender_name)}</a></div>
</td></tr><tr><td style="height:12px"></td></tr>`;
  }).join("");

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden">Based on your profile — checking these doesn't affect your credit score.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 4px 16px;font-size:16px;color:#18181b">Hi ${escapeHtml(name)},<br><br>Based on the details shared with us, you may be eligible for these personal loans:</td></tr>
${cards}
${more > 0 ? `<tr><td style="padding:0 4px 12px;font-size:14px;color:#3f3f46">+ ${more} more option${more === 1 ? "" : "s"} matched your profile.</td></tr>` : ""}
<tr><td style="padding:8px 4px;font-size:12px;line-height:1.5;color:#71717a">These are indicative matches based on publicly listed criteria — not loan offers or approvals. Final eligibility, rates and amounts are decided by the lender.<br><br>
You're receiving this because you shared your details for loan offers. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#71717a">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    `Hi ${name},`, "", "Based on the details shared with us, you may be eligible for these personal loans:", "",
    ...products.flatMap((p) => [
      `• ${p.product_name} — ${p.lender_name}`, `  ${rateText(p)}`,
      ...reasons(n, p).map((r) => `  ✓ ${r}`), ...(p.unverified || []).map((u) => `  ? To confirm: ${u}`),
      `  ${p.source_url}`, "",
    ]),
    more > 0 ? `+ ${more} more option(s) matched your profile.\n` : "",
    "Indicative matches only — not loan offers. The lender decides final eligibility.",
    `Unsubscribe: ${unsubscribeUrl}`,
  ].join("\n");

  return { subject, html, text };
}

if (typeof module !== "undefined") {
  module.exports = { renderEmail, unsubscribeToken, formatINR, escapeHtml, reasons };
}
