// Pre-upload check of a spreadsheet, in the browser, from its first 64 KB only.
// Uses the server's own column/alias table (GET /v1/uploads/schema), so "looks fine here" means
// "the server will find these columns". The server still validates every row — the browser can
// be bypassed — this just catches the wrong file before anyone waits for an upload.

import type { ColumnSpec } from "../api/types.ts";

export const SNIFF_BYTES = 64 * 1024;
const DELIMITERS = [",", ";", "\t", "|"] as const;
const HEAD_LINES = 20;

export interface ColumnMatch {
  column: string;
  required: boolean;
  header: string | null; // the header text found in the file, or null if missing
}

export interface Inspection {
  ok: boolean;
  problem: string | null;      // a reason the file will certainly fail
  encoding: string;
  delimiter: string;
  headerRowNumber: number;     // 1-based, as Excel shows it
  matches: ColumnMatch[];
  missingRequired: string[];
  previewHeader: string[];
  previewRows: string[][];
  estimatedRows: number;
}

/** Same normalisation as packages/ingestion/private/normalize.py::normalize_header. */
export function normalizeHeader(cell: string): string {
  return cell
    .replace(/﻿/g, "")
    .trim()
    .toLowerCase()
    .replace(/\((?:₹|rs\.?|inr|in rs\.?|in ₹|per month|monthly|years|yrs)\)/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function decodeHead(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "UTF-8 (BOM)" };
  }
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    const le = bytes[0] === 0xff;
    return { text: new TextDecoder(le ? "utf-16le" : "utf-16be").decode(bytes.subarray(2)), encoding: "UTF-16" };
  }
  try {
    // stream: true tolerates a multi-byte character cut at the 64 KB boundary
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true }), encoding: "UTF-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "Windows-1252" };
  }
}

/** RFC 4180 parsing of a text fragment (quoted cells may contain delimiters, quotes and newlines). */
export function parseCsv(text: string, delimiter: string, maxRows = Infinity): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if ((cell !== "" || row.length) && rows.length < maxRows) { row.push(cell); rows.push(row); }
  return rows;
}

function aliasTable(columns: ColumnSpec[]): Map<string, string> {
  const table = new Map<string, string>();
  for (const c of columns) for (const alias of c.aliases) table.set(alias, c.name);
  return table;
}

export function inspectCsv(bytes: Uint8Array, fileSize: number, columns: ColumnSpec[]): Inspection {
  const empty = (problem: string, encoding = "—"): Inspection => ({
    ok: false, problem, encoding, delimiter: ",", headerRowNumber: 0, matches: [], previewHeader: [],
    previewRows: [], estimatedRows: 0, missingRequired: columns.filter((c) => c.required).map((c) => c.name),
  });
  if (bytes.length === 0) return empty("The file is empty.");
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return empty("This is an Excel workbook (.xlsx). In Excel use File → Save As → CSV UTF-8, then upload that file.");
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return empty("Compressed files can't be previewed here. Upload the plain .csv file.");

  const { text, encoding } = decodeHead(bytes);
  const aliases = aliasTable(columns);
  const headLines = text.split(/\r\n|\n|\r/).slice(0, HEAD_LINES).join("\n");

  // Try every delimiter on the first lines; the row matching the most known columns is the header.
  let best = { hits: 0, delimiter: ",", index: 0, cells: [] as string[] };
  for (const delimiter of DELIMITERS) {
    parseCsv(headLines, delimiter, HEAD_LINES).forEach((cells, index) => {
      const hits = new Set(cells.map((c) => aliases.get(normalizeHeader(c))).filter(Boolean)).size;
      if (hits > best.hits) best = { hits, delimiter, index, cells };
    });
  }
  if (best.hits < 3) {
    return empty("No header row found. The first row should name the columns, e.g. user_id, email, monthly_income …", encoding);
  }

  const found = new Map<string, string>();
  best.cells.forEach((cell) => {
    const canon = aliases.get(normalizeHeader(cell));
    if (canon && !found.has(canon)) found.set(canon, cell.trim());
  });
  const matches = columns.map((c) => ({ column: c.name, required: c.required, header: found.get(c.name) ?? null }));
  const missingRequired = matches.filter((m) => m.required && !m.header).map((m) => m.column);

  const rows = parseCsv(text, best.delimiter, best.index + 7);
  const previewRows = rows.slice(best.index + 1).filter((r) => r.some((c) => c.trim())).slice(0, 5);
  const avgLine = text.length / Math.max(1, text.split("\n").length);
  const estimatedRows = Math.max(previewRows.length, Math.round(fileSize / Math.max(1, avgLine)) - (best.index + 1));

  return {
    ok: missingRequired.length === 0,
    problem: missingRequired.length ? `Missing required column${missingRequired.length > 1 ? "s" : ""}: ${missingRequired.join(", ")}` : null,
    encoding,
    delimiter: best.delimiter,
    headerRowNumber: best.index + 1,
    matches,
    missingRequired,
    previewHeader: best.cells,
    previewRows,
    estimatedRows,
  };
}

/** A CSV template built from the schema: the header row plus one example row. */
export function templateCsv(columns: ColumnSpec[]): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return `${columns.map((c) => c.name).join(",")}\n${columns.map((c) => esc(c.example)).join(",")}\n`;
}
