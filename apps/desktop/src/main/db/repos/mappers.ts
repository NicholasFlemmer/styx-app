/** Shared SQLite ↔ entity coercions. Rows come out as `Raw` and are parsed with the core zod schemas. */
export type Raw = Record<string, unknown>;

export const asBool = (v: unknown): boolean => v === 1 || v === true;
export const toBit = (v: boolean): number => (v ? 1 : 0);
export const asStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
export const asNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
/** NOT NULL timestamp columns store 0 for "never". */
export const asTime = (v: unknown): number | null => {
  const n = asNum(v);
  return n === null || n === 0 ? null : n;
};
export const toTime = (v: number | null): number => v ?? 0;
export const asJson = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string' || v === '') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
export const toJson = (v: unknown): string => JSON.stringify(v ?? null);

export const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');
