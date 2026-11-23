// CSV for spreadsheets. UTF-8 with a BOM so Excel reads accents correctly.

export type Column<T> = [header: string, value: (row: T) => string | number | null | undefined];

function cell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv<T>(rows: T[], columns: Column<T>[]): string {
  const lines = [columns.map(([h]) => cell(h)).join(',')];
  for (const r of rows) lines.push(columns.map(([, f]) => cell(f(r))).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** CSV from flat rows whose columns vary: the union of keys, in first-seen order. */
export function flatRowsToCsv(rows: Array<Record<string, string | number>>, first: string[] = []): string {
  const keys = new Set<string>(first.filter((k) => rows.some((r) => k in r)));
  for (const r of rows) for (const k of Object.keys(r)) keys.add(k);
  return toCsv(rows, [...keys].map((k): Column<Record<string, string | number>> => [k, (r) => r[k]]));
}

export const round =(n: number | null | undefined, digits: number) =>
  typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(digits)) : null;

export function hms(seconds: number | null | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}
