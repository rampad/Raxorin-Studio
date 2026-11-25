#!/usr/bin/env python3
"""Prueba real del chat con Claude Code (los mismos argumentos que src/ai/claudeCode.ts).

   python3 tests/ai/claude_code.py <raxorin-studio> [modelo]

Crea un proyecto temporal, lanza `claude` en modo stream-json con el MCP de Raxorin Studio y el
puente de aprobación (una ventana falsa que aprueba todo y anota qué se le preguntó), y pide un
cambio pequeño. Usa la cuenta de Claude Code del equipo (gasta un poco de cuota).
"""
import json, os, shutil, socket, subprocess, sys, tempfile, threading

exe = os.path.abspath(sys.argv[1])
model = sys.argv[2] if len(sys.argv) > 2 else "haiku"
sys.stdout.reconfigure(encoding="utf-8")
root = os.path.realpath(tempfile.mkdtemp(prefix="raxorin-cc-"))
subprocess.run(["cargo", "new", "--quiet", "saludo"], cwd=root, check=True)
proj = os.path.join(root, "saludo")

# Ventana falsa: aprueba y anota.
srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen()
asked = []
def window():
    while True:
        c, _ = srv.accept()
        msg = json.loads(c.makefile().readline())
        asked.append((msg["toolName"], msg["input"]))
        c.sendall(b'{"allow": true}\n'); c.close()
threading.Thread(target=window, daemon=True).start()

MCP = "raxorin-studio"
READ_ONLY = ["ide_info", "list_projects", "list_dir", "read_file", "build", "check", "test", "format", "explain_error", "search_crates", "list_samples", "slint_controls"]
cfg = os.path.join(root, "mcp.json")
with open(cfg, "w") as f:
    json.dump({"mcpServers": {MCP: {"command": exe, "args": ["--mcp", "--root", proj, "--approval-bridge", "127.0.0.1:%d" % srv.getsockname()[1]], "env": {"RAXORIN_APPROVAL_TOKEN": "t"}}}}, f)
args = ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--mcp-config", cfg, "--strict-mcp-config", "--permission-prompt-tool", f"mcp__{MCP}__approve",
        "--tools", "Read,Grep,Glob,Edit,Write,MultiEdit,Bash",
        "--allowedTools", ",".join(["Read", "Grep", "Glob"] + [f"mcp__{MCP}__{n}" for n in READ_ONLY]),
        "--append-system-prompt", "You are running inside Raxorin Studio's chat panel. Prefer the raxorin-studio MCP tools.",
        "--model", model]
p = subprocess.Popen(args, cwd=proj, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
prompt = (f"In {proj}/src/main.rs change the printed text to \"Hola desde Raxorin\". "
          "Then build the project with the raxorin-studio build tool and tell me in one sentence if it compiled.")
p.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": prompt}]}}) + "\n"); p.stdin.flush()

seen = {"init": None, "text_deltas": 0, "tools": [], "results": 0, "result": None}
for line in p.stdout:
    m = json.loads(line)
    t = m.get("type")
    if t == "system" and m.get("subtype") == "init":
        seen["init"] = [s for s in m.get("mcp_servers", []) if s["name"] == MCP]
    elif t == "stream_event" and m["event"].get("type") == "content_block_delta" and m["event"]["delta"].get("type") == "text_delta":
        seen["text_deltas"] += 1
    elif t == "assistant":
        seen["tools"] += [b["name"] for b in m["message"]["content"] if b["type"] == "tool_use"]
    elif t == "user":
        seen["results"] += sum(1 for b in m["message"]["content"] if isinstance(b, dict) and b.get("type") == "tool_result")
    elif t == "result":
        seen["result"] = m
        break
p.stdin.close(); p.wait(timeout=30)

main = open(os.path.join(proj, "src/main.rs")).read()
r = seen["result"] or {}
print("MCP en init:", seen["init"])
print("deltas de texto:", seen["text_deltas"], "· herramientas:", seen["tools"], "· resultados:", seen["results"])
print("aprobaciones pedidas:", [a[0] for a in asked])
print("resultado:", r.get("subtype"), "is_error:", r.get("is_error"), "·", (r.get("result") or "")[:200])
print("main.rs cambiado:", "Hola desde Raxorin" in main)
ok = bool(seen["init"]) and seen["init"][0]["status"] == "connected" and seen["text_deltas"] > 0 and asked and "Hola desde Raxorin" in main and not r.get("is_error")
shutil.rmtree(root, ignore_errors=True)
print("\nTodo OK" if ok else "\nFALLA")
sys.exit(0 if ok else 1)
