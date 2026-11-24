// Formato de números, fechas y versiones para el gestor de paquetes.

const compact = new Intl.NumberFormat("es", { notation: "compact", maximumFractionDigits: 1 });
export const formatCount = (n: number) => compact.format(n);

const rtf = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
export function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const secs = (t - Date.now()) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(secs) >= size) return rtf.format(Math.round(secs / size), unit);
  }
  return "ahora";
}

export const formatDate = (iso: string) =>
  Number.isNaN(Date.parse(iso)) ? "" : new Date(iso).toLocaleDateString("es", { year: "numeric", month: "short", day: "numeric" });

/** "^1.2" → "1.2" */
export const stripReq = (req: string) => req.replace(/^[\^~=<>\s]+/, "").split(",")[0].trim();

const parts = (v: string) => stripReq(v).split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);

export function compareVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** ¿Pasar de `from` a `to` puede romper el código? (regla de semver de Cargo) */
export function isBreaking(from: string, to: string): boolean {
  const [a, b] = [parts(from), parts(to)];
  if (a[0] !== b[0]) return true;
  if (a[0] === 0 && a[1] !== b[1]) return true;
  if (a[0] === 0 && a[1] === 0 && a[2] !== b[2]) return true;
  return false;
}

/** Nombre con el que se importa en el código (`serde_json`, no `serde-json`). */
export const libName = (crate: string) => crate.replace(/-/g, "_");
