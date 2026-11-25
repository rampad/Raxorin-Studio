#!/usr/bin/env python3
"""Prueba de punta a punta del servidor MCP de Raxorin Studio.

   python3 tests/mcp/sesion.py <ruta al ejecutable raxorin-studio>

Habla JSON-RPC por stdio con `raxorin-studio --mcp --root <carpeta temporal>` y recorre las
herramientas sobre un proyecto real: crear, compilar con error, corregir, probar, ejecutar con
entrada, explicar un error, catálogo de Slint y el bloqueo de rutas fuera de la carpeta autorizada.
"""
import json, os, shutil, subprocess, sys, tempfile

# La consola de Windows en CI usa cp1252: los ✔/✖ se escriben en UTF-8.
sys.stdout.reconfigure(encoding="utf-8")
exe = sys.argv[1]
root = os.path.realpath(tempfile.mkdtemp(prefix="raxorin-mcp-"))
proc = subprocess.Popen([exe, "--mcp", "--root", root], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8")
fails = 0
next_id = 0


def ok(cond, name):
    global fails
    print(("✔ " if cond else "✖ ") + name)
    if not cond:
        fails += 1


def request(method, params=None):
    global next_id
    next_id += 1
    proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": next_id, "method": method, "params": params or {}}) + "\n")
    proc.stdin.flush()
    progress = 0
    while True:
        msg = json.loads(proc.stdout.readline())
        if msg.get("method") == "notifications/progress":
            progress += 1
            continue
        if msg.get("id") == next_id:
            msg["_progress"] = progress
            return msg


def call(name, args, token=None):
    params = {"name": name, "arguments": args}
    if token:
        params["_meta"] = {"progressToken": token}
    r = request("tools/call", params)["result"]
    return r, r["content"][0]["text"]


try:
    init = request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "prueba", "version": "1"}})
    ok(init["result"]["serverInfo"]["name"] == "raxorin-studio" and init["result"]["protocolVersion"] == "2025-06-18", "initialize")
    proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
    proc.stdin.flush()
    tools = [t["name"] for t in request("tools/list")["result"]["tools"]]
    ok(len(tools) >= 15 and "build" in tools, f"tools/list ({len(tools)} herramientas)")

    r, text = call("create_project", {"parent": root, "name": "hello_mcp", "kind": "bin", "language": "en"})
    project = os.path.join(root, "hello_mcp")
    ok(not r["isError"] and os.path.isfile(os.path.join(project, "src/main.rs")), "create_project")

    r, text = call("list_projects", {"path": root})
    ok(r["structuredContent"]["projects"][0]["name"] == "hello_mcp", "list_projects")

    # Un error a propósito: variable inmutable.
    call("write_file", {"path": os.path.join(project, "src/main.rs"), "content": "fn main() {\n    let total = 0;\n    total += 5;\n    println!(\"{total}\");\n}\n"})
    r, text = call("build", {"project": project}, token="b1")
    d = r["structuredContent"]["diagnostics"]
    ok(r["isError"] and r["structuredContent"]["errors"] == 1 and d[0]["code"] == "E0384" and d[0]["line"] == 3, "build: error E0384 en la línea 3")
    ok("let mut total" in text, "build: incluye la sugerencia del compilador")

    r, text = call("explain_error", {"code": "E0384"})
    ok("immutable" in text, "explain_error")

    code = """use std::io::{self, BufRead};

pub fn double(n: i32) -> i32 { n * 2 }

fn main() {
    let line = io::stdin().lock().lines().next().unwrap().unwrap();
    let n: i32 = line.trim().parse().unwrap();
    println!("double: {}", double(n));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn doubles() { assert_eq!(double(21), 42); }
    #[test] fn fails() { assert_eq!(double(1), 3); }
}
"""
    call("write_file", {"path": os.path.join(project, "src/main.rs"), "content": code})
    r, text = call("build", {"project": project})
    ok(not r["isError"] and r["structuredContent"]["errors"] == 0, "build: corregido")

    r, text = call("test", {"project": project})
    s = r["structuredContent"]
    ok(s["passed"] == 1 and s["failed"] == 1 and "tests::fails" in s["failing"][0], f"test: 1 pasa, 1 falla ({text.splitlines()[0]})")

    r, text = call("run", {"project": project, "stdin": "21\n", "timeout_secs": 60})
    ok(not r["isError"] and "double: 42" in r["structuredContent"]["stdout"], "run con entrada por teclado")

    r, text = call("check", {"project": project})
    ok("diagnostics" in r["structuredContent"], f"check ({text.splitlines()[0]})")

    r, text = call("slint_controls", {"type": "Button"})
    ok(r["structuredContent"]["type"] == "Button" and any(e["name"] == "clicked" for e in r["structuredContent"]["events"]), "slint_controls")

    r, text = call("list_samples", {})
    ok(any(s["id"] == "calculadora" and s["name"] == "Calculator" for s in r["structuredContent"]["samples"]), "list_samples (en inglés)")

    outside = os.path.join(os.path.dirname(root), "raxorin-mcp-fuera.txt")
    with open(outside, "w") as f:
        f.write("secreto")
    r, text = call("read_file", {"path": outside})
    os.remove(outside)
    ok(r["isError"] and "outside the allowed folders" in text, "read_file fuera de la carpeta autorizada: rechazado")
    r, text = call("write_file", {"path": os.path.join(root, "..", "fuera.txt"), "content": "x"})
    ok(r["isError"] and not os.path.exists(os.path.join(os.path.dirname(root), "fuera.txt")), "write_file con .. : rechazado")

    err = request("no/existe")
    ok(err.get("error", {}).get("code") == -32601, "método desconocido: -32601")
finally:
    proc.stdin.close()
    proc.wait(timeout=10)
    shutil.rmtree(root, ignore_errors=True)

print("\nTodo OK" if not fails else f"\n{fails} FALLA(S)")
sys.exit(1 if fails else 0)
