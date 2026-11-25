// Diferencias línea a línea para aprobar cambios (sin dependencias).

export type DiffLine = { kind: "same" | "add" | "del"; text: string; oldNo?: number; newNo?: number };

/** LCS sobre líneas, con el prefijo y el sufijo comunes recortados (los cambios suelen ser locales). */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ kind: "same", text: a[i], oldNo: i + 1, newNo: i + 1 });
  const ma = a.slice(start, endA), mb = b.slice(start, endB);
  if (ma.length * mb.length > 4_000_000) {
    // Demasiado grande para LCS: todo lo del medio como quitado y agregado.
    ma.forEach((t, i) => out.push({ kind: "del", text: t, oldNo: start + i + 1 }));
    mb.forEach((t, i) => out.push({ kind: "add", text: t, newNo: start + i + 1 }));
  } else {
    const n = ma.length, m = mb.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = ma[i] === mb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && ma[i] === mb[j]) {
        out.push({ kind: "same", text: ma[i], oldNo: start + i + 1, newNo: start + j + 1 });
        i++;
        j++;
      } else if (j < m && (i >= n || dp[i][j + 1] > dp[i + 1][j])) {
        // En empate, primero lo quitado y después lo agregado (como en git).
        out.push({ kind: "add", text: mb[j], newNo: start + j + 1 });
        j++;
      } else {
        out.push({ kind: "del", text: ma[i], oldNo: start + i + 1 });
        i++;
      }
    }
  }
  const tailOld = endA, tailNew = endB;
  for (let k = 0; k < a.length - endA; k++) out.push({ kind: "same", text: a[tailOld + k], oldNo: tailOld + k + 1, newNo: tailNew + k + 1 });
  return out;
}

/** Bloques para mostrar: los cambios con `context` líneas alrededor; lo demás se resume. */
export function hunks(lines: DiffLine[], context = 3): (DiffLine | { kind: "skip"; count: number })[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind !== "same") for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: (DiffLine | { kind: "skip"; count: number })[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) out.push({ kind: "skip", count: skipped });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped) out.push({ kind: "skip", count: skipped });
  return out;
}

/** Igual que edit_file del MCP (src-tauri/src/mcp.rs): para mostrar el resultado antes de aprobarlo. */
export function applyEdit(text: string, oldText: string, newText: string, all = false): string | null {
  let o = oldText, n = newText;
  if (text.includes("\r\n") && !o.includes("\r\n")) {
    o = o.replace(/\n/g, "\r\n");
    n = n.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  }
  const count = o ? text.split(o).length - 1 : 0;
  if (count === 0 || (count > 1 && !all)) return null;
  return all ? text.split(o).join(n) : text.replace(o, () => n);
}
