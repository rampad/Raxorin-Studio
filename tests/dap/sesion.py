#!/usr/bin/env python3
"""Prueba una sesión de depuración completa por DAP, con la misma configuración de inicio que
usa Raxorin Studio (src/debug/controller.ts). Sirve para lldb-dap y para CodeLLDB.

    python3 tests/dap/sesion.py <adaptador> <lldb-dap|codelldb> [--entrada]

Compila tests/dap/ejemplo, se detiene en la línea marcada con "PUNTO", revisa las variables,
evalúa y cambia una variable, continúa y comprueba la salida del programa. Con --entrada
(macOS/Linux) también envía una línea por la entrada estándar, como hace la app (FIFO).
"""
import json, os, queue, subprocess, sys, tempfile, threading, time

# La consola de Windows usa otra codificación: forzar UTF-8 para los ✔/✖.
sys.stdout.reconfigure(encoding="utf-8")

adapter, kind = sys.argv[1], sys.argv[2]
con_entrada = "--entrada" in sys.argv
aqui = os.path.dirname(os.path.abspath(__file__))
proyecto = os.path.join(aqui, "ejemplo")
fuente = os.path.join(proyecto, "src", "main.rs")
linea_punto = next(i + 1 for i, l in enumerate(open(fuente, encoding="utf-8")) if "PUNTO" in l)

subprocess.run(["cargo", "build", "-q"], cwd=proyecto, check=True)
exe = os.path.join(proyecto, "target", "debug", "ejemplo-depurar" + (".exe" if os.name == "nt" else ""))

fallas = []
def ok(cond, msg):
    print(("✔ " if cond else "✖ ") + msg, flush=True)
    if not cond:
        fallas.append(msg)

env = dict(os.environ)
if con_entrada:
    env["CON_ENTRADA"] = "1"
p = subprocess.Popen([adapter], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)
mensajes = queue.Queue()
salida = []
def lector():
    while True:
        cab = p.stdout.readline()
        if not cab:
            break
        if cab.startswith(b"Content-Length:"):
            n = int(cab.split(b":")[1])
            p.stdout.readline()
            m = json.loads(p.stdout.read(n))
            if m.get("event") == "output" and m["body"].get("category") in ("stdout", "stderr"):
                salida.append(m["body"]["output"])
            mensajes.put(m)
threading.Thread(target=lector, daemon=True).start()

seq = 0
def enviar(cmd, args=None):
    global seq
    seq += 1
    m = json.dumps({"seq": seq, "type": "request", "command": cmd, "arguments": args or {}})
    p.stdin.write(f"Content-Length: {len(m.encode())}\r\n\r\n{m}".encode())
    p.stdin.flush()
    return seq
pendientes = []  # mensajes que llegaron antes de que se los esperara (no se descartan)
def esperar(pred, t=60):
    for i, m in enumerate(pendientes):
        if pred(m):
            return pendientes.pop(i)
    fin = time.time() + t
    while time.time() < fin:
        try:
            m = mensajes.get(timeout=max(0.1, fin - time.time()))
        except queue.Empty:
            break
        if pred(m):
            return m
        pendientes.append(m)
    sys.exit("✖ tiempo agotado")
respuesta = lambda s: (lambda m: m.get("type") == "response" and m.get("request_seq") == s)
def pedir(cmd, args=None):
    r = esperar(respuesta(enviar(cmd, args)))
    return r

# Entrada estándar: como la app, por un FIFO y "settings set target.input-path".
fifo = None
escribir_ya = threading.Event()
if con_entrada:
    fifo = os.path.join(tempfile.mkdtemp(), "entrada")
    os.mkfifo(fifo)
    # Como la app: el lado de escritura queda abierto desde antes de iniciar (si no, el programa
    # se bloquearía al abrir su entrada). La línea se envía después del punto de interrupción.
    def escritor():
        with open(fifo, "w") as f:
            escribir_ya.wait()
            f.write("hola\n")
    threading.Thread(target=escritor, daemon=True).start()

r = pedir("initialize", {"clientID": "raxorin-studio", "adapterID": "lldb" if kind == "codelldb" else "lldb-dap",
                         "linesStartAt1": True, "columnsStartAt1": True, "pathFormat": "path", "supportsVariableType": True})
ok(r["success"], f"initialize ({kind})")
pre = ["breakpoint set --name rust_panic"] + ([f'settings set target.input-path "{fifo}"'] if fifo else [])
launch = {"program": exe, "cwd": proyecto, "stopOnEntry": False, "preRunCommands": pre}
if kind == "codelldb":
    launch.update({"type": "lldb", "request": "launch", "terminal": "console", "sourceLanguages": ["rust"]})
else:
    # lldb-dap: como la app, los formateadores de Rust de rustc y la protección de Raxorin Studio.
    sysroot = subprocess.run(["rustc", "--print", "sysroot"], capture_output=True, text=True).stdout.strip()
    guard = os.path.join(aqui, "..", "..", "src-tauri", "src", "raxorin_lldb_guard.py")
    launch["initCommands"] = [f'command script import "{os.path.join(sysroot, "lib", "rustlib", "etc", "lldb_lookup.py")}"',
                              f'command script import "{os.path.abspath(guard)}"']
enviar("launch", launch)
esperar(lambda m: m.get("event") == "initialized")
r = pedir("setBreakpoints", {"source": {"path": fuente}, "breakpoints": [{"line": linea_punto}]})
ok(r["body"]["breakpoints"][0].get("verified", False), f"punto de interrupción en la línea {linea_punto}")
pedir("configurationDone")
st = esperar(lambda m: m.get("event") == "stopped")
tid = st["body"]["threadId"]
ok(st["body"]["reason"] == "breakpoint", "se detuvo en el punto de interrupción")
marco = pedir("stackTrace", {"threadId": tid, "levels": 1})["body"]["stackFrames"][0]
ok(marco["line"] == linea_punto and "main" in marco["name"], f"marco: {marco['name']} línea {marco['line']}")
ambitos = pedir("scopes", {"frameId": marco["id"]})["body"]["scopes"]
locales = pedir("variables", {"variablesReference": ambitos[0]["variablesReference"]})["body"]["variables"]
v = {x["name"]: x for x in locales}
print("  variables:", {k: x["value"] for k, x in v.items()})
ok('"Ana"' in v.get("nombre", {}).get("value", ""), "String legible (nombre = \"Ana\")")
ok("Some(7)" in v.get("quizas", {}).get("value", "").replace(" ", ""), "Option legible (quizas = Some(7))")
ok(v.get("total", {}).get("value") == "6", "total = 6")
ok(v.get("numeros", {}).get("variablesReference", 0) > 0, "Vec con elementos para expandir")
r = pedir("evaluate", {"expression": "total", "frameId": marco["id"], "context": "watch"})
ok(r["success"] and r["body"]["result"] == "6", "evaluar una expresión (inspección)")
r = pedir("setVariable", {"variablesReference": ambitos[0]["variablesReference"], "name": "total", "value": "41"})
ok(r["success"] and r["body"]["value"] == "41", "cambiar el valor de una variable")
r = pedir("evaluate", {"expression": "total", "frameId": marco["id"], "context": "watch"})
ok(r["success"] and r["body"]["result"] == "41", "el valor cambiado se mantiene (total = 41)")
# En Windows, CodeLLDB abre el programa en su propia ventana de consola: su salida no llega
# como eventos "output" (la app lo avisa). En macOS y Linux sí.
captura_salida = os.name != "nt"

escribir_ya.set()
for _ in range(6):
    enviar("continue", {"threadId": tid})
    m = esperar(lambda m: m.get("event") in ("stopped", "exited", "terminated"))
    if m.get("event") != "stopped":
        break
fin = m if m.get("event") == "exited" else esperar(lambda m: m.get("event") in ("exited", "terminated"), 20)
time.sleep(0.5)
texto = "".join(salida).strip()
print("  salida del programa:", repr(texto))
ok(fin.get("event") == "exited" and fin["body"].get("exitCode") == 0, "el programa terminó con código 0")
if captura_salida:
    ok(texto.startswith("Ana 42 Some(7)"), "la salida refleja el valor cambiado (42)")
if fifo:
    ok(texto.endswith("[hola]"), "el programa leyó la entrada estándar")
p.kill()
print("\n" + (f"{len(fallas)} FALLA(S)" if fallas else "Todo OK"))
sys.exit(1 if fallas else 0)
