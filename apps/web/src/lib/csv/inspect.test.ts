import assert from "node:assert/strict";
import test from "node:test";
import type { ColumnSpec } from "../api/types.ts";
import { inspectCsv, normalizeHeader, parseCsv, templateCsv } from "./inspect.ts";

const spec = (name: string, aliases: string[], required = true): ColumnSpec => ({ name, required, aliases, example: "x", hint: "" });
const COLUMNS = [
  spec("user_id", ["user_id", "customer_id"]), spec("name", ["name", "full_name"], false),
  spec("email", ["email", "email_id"]), spec("monthly_income", ["monthly_income", "monthly_salary"]),
  spec("credit_score", ["credit_score", "cibil_score"]), spec("employment_status", ["employment_status", "occupation"]),
  spec("age", ["age"]),
];
const enc = (s: string) => new TextEncoder().encode(s);

test("clean file: every column found, preview rows parsed", () => {
  const csv = "user_id,name,email,monthly_income,credit_score,employment_status,age\nU1,\"Rao, Asha\",a@x.com,50000,750,Salaried,30\n";
  const r = inspectCsv(enc(csv), csv.length, COLUMNS);
  assert.equal(r.ok, true);
  assert.equal(r.headerRowNumber, 1);
  assert.deepEqual(r.previewRows[0], ["U1", "Rao, Asha", "a@x.com", "50000", "750", "Salaried", "30"]);
});

test("messy export: title row, semicolons, Excel-style headers, BOM", () => {
  const csv = "﻿Leads export\n\nCustomer ID;Full Name;Email ID;Monthly Salary (₹);CIBIL Score;Occupation;Age\nC1;Asha;a@x.com;₹1,20,000;780;self employed;33\n";
  const r = inspectCsv(enc(csv), csv.length, COLUMNS);
  assert.equal(r.ok, true);
  assert.equal(r.delimiter, ";");
  assert.equal(r.headerRowNumber, 3);
  assert.equal(r.matches.find((m) => m.column === "monthly_income")?.header, "Monthly Salary (₹)");
});

test("missing required columns are named; Excel workbooks are caught", () => {
  const csv = "user_id,email,age\nU1,a@x.com,30\n";
  const r = inspectCsv(enc(csv), csv.length, COLUMNS);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missingRequired, ["monthly_income", "credit_score", "employment_status"]);
  const xlsx = inspectCsv(new Uint8Array([0x50, 0x4b, 3, 4]), 4, COLUMNS);
  assert.match(xlsx.problem ?? "", /Save As → CSV/);
});

test("Windows-1252 and UTF-16 decode", () => {
  const header = "user_id,email,monthly_income,credit_score,employment_status,age\n";
  const latin = new Uint8Array([...enc(header), ...enc("U1,a@x.com,50000,750,Salaried,30,"), 0xe9, 0x0a]);
  assert.equal(inspectCsv(latin, latin.length, COLUMNS).encoding, "Windows-1252");
  const u16 = new Uint8Array([0xff, 0xfe, ...[...header].flatMap((c) => [c.charCodeAt(0), 0])]);
  assert.equal(inspectCsv(u16, u16.length, COLUMNS).ok, true);
});

test("header normalisation matches the server", () => {
  assert.equal(normalizeHeader("Monthly Income (₹)"), "monthly_income");
  assert.equal(normalizeHeader("﻿User ID"), "user_id");
});

test("RFC 4180 quoting and template", () => {
  assert.deepEqual(parseCsv('a,"b ""q"", c",d\n', ","), [["a", 'b "q", c', "d"]]);
  assert.equal(templateCsv(COLUMNS.slice(0, 2)), "user_id,name\nx,x\n");
});
