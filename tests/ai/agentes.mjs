// Empaqueta tests/ai/agentes.test.ts (importa módulos de la interfaz) y lo ejecuta con Node.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "raxorin-ai-test-"));
const out = join(dir, "agentes.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("./agentes.test.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error",
  define: { "import.meta.glob": "__raxorinGlob", "import.meta.env": "{}" },
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); globalThis.__raxorinGlob = () => ({});" },
});
try {
  execFileSync(process.execPath, [out, ...process.argv.slice(2)], { stdio: "inherit" });
} catch {
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
