#!/usr/bin/env python3
"""Prueba real del chat con GitHub Copilot por ACP (lo mismo que hace src/ai/copilot.ts).

   python3 tests/ai/copilot_acp.py <copilot> <raxorin-studio>

Cliente ACP mínimo: aprueba los permisos y atiende fs/read_text_file y fs/write_text_file, anotando
todo. Usa la sesión de Copilot del equipo (gasta un poco de cuota).
"""
import json, os, shutil, subprocess, sys, tempfile

copilot, raxorin = sys.argv[1], os.path.abspath(sys.argv[2])
sys.stdout.reconfigure(encoding="utf-8")
root = os.path.realpath(tempfile.mkdtemp(prefix="raxorin-acp-"))
subprocess.run(["cargo", "new", "--quiet", "saludo"], cwd=root, check=True)
proj = os.path.join(root, "saludo")
p = subprocess.Popen([copilot, "--acp"], cwd=proj, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
log = {"permissions": [], "reads": [], "writes": [], "tool_calls": [], "updates": set(), "chunks": 0}

def send(m):
    p.stdin.write(json.dumps(m) + "\n"); p.stdin.flush()

def handle_request(m):
    method, prm = m["method"], m.get("params", {})
    if method == "session/request_permission":
        tc = prm["toolCall"]
        log["permissions"].append((tc.get("kind"), tc.get("title"), [c.get("type") for c in tc.get("content") or []], [o["kind"] for o in prm["options"]]))
        if os.environ.get("RAW"): print("PERMISO:", json.dumps(tc, ensure_ascii=False)[:2500])
        opt = next(o for o in prm["options"] if o["kind"] == "allow_once")
        return {"outcome": {"outcome": "selected", "optionId": opt["optionId"]}}
    if method == "fs/read_text_file":
        log["reads"].append(prm["path"])
        return {"content": open(prm["path"]).read()}
    if method == "fs/write_text_file":
        log["writes"].append(prm["path"])
        open(prm["path"], "w").write(prm["content"])
        return None
    raise KeyError(method)

def request(i, method, params):
    send({"jsonrpc": "2.0", "id": i, "method": method, "params": params})
    while True:
        line = p.stdout.readline()
        if not line:
            raise SystemExit("copilot terminó: " + p.stderr.read()[-1500:])
        m = json.loads(line)
        if "method" in m and "id" in m:
            try:
                send({"jsonrpc": "2.0", "id": m["id"], "result": handle_request(m)})
            except KeyError as e:
                send({"jsonrpc": "2.0", "id": m["id"], "error": {"code": -32601, "message": str(e)}})
        elif m.get("method") == "session/update":
            u = m["params"]["update"]
            log["updates"].add(u["sessionUpdate"])
            if u["sessionUpdate"] == "agent_message_chunk": log["chunks"] += 1
            if u["sessionUpdate"] == "tool_call": log["tool_calls"].append((u.get("kind"), u.get("title")))
        elif m.get("id") == i:
            return m

request(1, "initialize", {"protocolVersion": 1, "clientCapabilities": {"fs": {"readTextFile": True, "writeTextFile": True}, "terminal": False}, "clientInfo": {"name": "raxorin-studio", "title": "Raxorin Studio", "version": "test"}})
s = request(2, "session/new", {"cwd": proj, "mcpServers": [{"name": "raxorin-studio", "command": raxorin, "args": ["--mcp", "--root", proj], "env": []}]})["result"]
r = request(3, "session/prompt", {"sessionId": s["sessionId"], "prompt": [{"type": "text", "text":
    f"In {proj}/src/main.rs change the printed text to \"Hola desde Raxorin\". Then build it with the raxorin-studio MCP build tool and tell me in one sentence whether it compiled."}]})
p.kill()
main = open(os.path.join(proj, "src/main.rs")).read()
print("stopReason:", r.get("result", {}).get("stopReason"), r.get("error"))
print("updates:", sorted(log["updates"]), "· chunks:", log["chunks"])
print("tool_calls:", log["tool_calls"])
print("permisos:", log["permissions"])
print("lecturas:", log["reads"], "· escrituras:", log["writes"])
print("main.rs cambiado:", "Hola desde Raxorin" in main)
shutil.rmtree(root, ignore_errors=True)
ok = "Hola desde Raxorin" in main and log["permissions"]
print("\nTodo OK" if ok else "\nFALLA")
sys.exit(0 if ok else 1)
