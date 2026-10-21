// Display formatting. Indian conventions: ₹ and lakh/crore digit grouping (1,50,000).

const grouping = new Intl.NumberFormat("en-IN");

export const num = (value: number | null | undefined): string =>
  value === null || value === undefined || Number.isNaN(Number(value)) ? "—" : grouping.format(Number(value));

export const inr = (value: number | null | undefined): string => (value === null || value === undefined ? "—" : `₹${num(value)}`);

/** 1.2 lakh, 1 crore — how loan amounts are spoken about in India. */
export function inrShort(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value >= 1e7) return `₹${trim(value / 1e7)} crore`;
  if (value >= 1e5) return `₹${trim(value / 1e5)} lakh`;
  return inr(value);
}
const trim = (n: number) => (Math.round(n * 100) / 100).toString();

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const units: [number, string][] = [[60, "minute"], [3600, "hour"], [86400, "day"], [604800, "week"]];
  for (let i = units.length - 1; i >= 0; i--) {
    const [size, label] = units[i]!;
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `${n} ${label}${n === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

export const percent = (part: number, whole: number): string =>
  whole > 0 ? `${Math.round((100 * part) / whole)}%` : "—";

export function rateRange(min: number | null, max: number | null): string {
  if (min === null) return "Not published";
  return max === null || Number(max) === Number(min) ? `from ${Number(min)}% p.a.` : `${Number(min)}–${Number(max)}% p.a.`;
}
