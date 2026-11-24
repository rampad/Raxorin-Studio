// Texto de los atajos de teclado según el sistema.

export const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

/** "Mod+Shift+S" → "⇧⌘S" en macOS o "Ctrl+Shift+S" en Windows/Linux. */
export function formatShortcut(s: string, mac = IS_MAC) {
  if (!mac) return s.replace(/Mod/g, "Ctrl");
  const parts = s.split("+");
  const key = parts.pop()!;
  const sym: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Mod: "⌘" };
  const order = ["Ctrl", "Alt", "Shift", "Mod"];
  return order.filter((m) => parts.includes(m)).map((m) => sym[m]).join("") + key;
}
