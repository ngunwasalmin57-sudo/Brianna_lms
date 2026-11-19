// Accepts 0712345678 or +255712345678 (also 06xx). Stores 07XXXXXXXX.
export function normalizePhone(raw: string): string | null {
  const s = raw.replace(/[\s-]/g, "");
  const m = s.match(/^(?:\+?255|0)([67]\d{8})$/);
  return m ? "0" + m[1] : null;
}
