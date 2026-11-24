import { DEFAULT_SETTINGS, normalizeSettings } from "../src/settings.ts";
import { formatShortcut } from "../src/shortcuts.ts";
let fails = 0;
const ok = (cond: boolean, msg: string) => { console.log((cond ? "✔ " : "✖ ") + msg); if (!cond) fails++; };

ok(JSON.stringify(normalizeSettings(null)) === JSON.stringify(DEFAULT_SETTINGS), "sin configuración guardada → valores por defecto");
const s = normalizeSettings({ fontSize: 99, tabSize: 3, wordWrap: true, minimap: "no", extra: 1 });
ok(s.fontSize === 32, "tamaño de letra limitado a 32");
ok(s.tabSize === 4, "tabulación inválida → 4");
ok(s.wordWrap === true, "conserva valores válidos");
ok(s.minimap === DEFAULT_SETTINGS.minimap, "ignora valores de otro tipo");
ok(!("extra" in s), "ignora claves desconocidas");
ok(normalizeSettings({ fontSize: 3 }).fontSize === 8, "tamaño de letra mínimo 8");
ok(formatShortcut("Mod+Shift+S", false) === "Ctrl+Shift+S", "atajo en Windows/Linux");
ok(formatShortcut("Mod+Shift+S", true) === "⇧⌘S", "atajo en macOS");
ok(formatShortcut("Mod+Alt+S", true) === "⌥⌘S" && formatShortcut("F5", true) === "F5", "atajos con Alt y teclas sueltas");

console.log(fails ? `\n${fails} FALLA(S)` : "\nTodo OK");
if (fails) process.exit(1);
