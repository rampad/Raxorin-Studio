// Rutas de @image-url (relativas al archivo .slint).

/** Une la carpeta y la ruta relativa, resolviendo `.` y `..`. */
export function resolveImagePath(base: string | null, src: string): string {
  const isAbs = /^([a-zA-Z]:[\\/]|[\\/])/.test(src);
  if (isAbs || !base) return src;
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  const parts = base.replace(/[\\/]+$/, "").split(/[\\/]/);
  for (const seg of src.split(/[\\/]/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join(sep);
}
