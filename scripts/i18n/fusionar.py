#!/usr/bin/env python3
"""Fusiona traducciones numeradas (tr-*.json) con la lista de claves (*-keys.json) y reescribe
src/i18n/en.ts o src/i18n/backend-en.ts, conservando las traducciones que ya había.

   python3 scripts/i18n/fusionar.py ui <carpeta>       (interfaz → en.ts)
   python3 scripts/i18n/fusionar.py backend <carpeta>  (backend → backend-en.ts)
"""
import glob, json, re, sys, os, subprocess

kind, folder = sys.argv[1], sys.argv[2]
root = os.path.join(os.path.dirname(__file__), "..", "..")
prefix = "ui" if kind == "ui" else "be"
keys = json.load(open(f"{folder}/{prefix}-keys.json"))
tr = {}
for f in sorted(glob.glob(f"{folder}/tr-{prefix}-*.json")):
    tr.update(json.load(open(f)))
target = os.path.join(root, "src/i18n", "en.ts" if kind == "ui" else "backend-en.ts")
var = "EN" if kind == "ui" else "BACKEND_EN"
header = open(target).read().split("export const")[0]
# Traducciones existentes (para no perderlas al agregar nuevas)
existing = json.loads(subprocess.run(["node", "-e", f"import('{os.path.abspath(target)}').then(m=>console.log(JSON.stringify(m.{var})))"],
                                     capture_output=True, text=True, check=True).stdout)
problems = []
for i, k in enumerate(keys):
    v = tr.get(str(i))
    if v is None:
        continue
    ph_es = sorted(set(re.findall(r"\{\d+\}", k)))
    ph_en = sorted(set(re.findall(r"\{\d+\}", v)))
    if ph_es != ph_en:
        problems.append(f"{i}: valores distintos {ph_es} → {ph_en}: {k!r}")
    existing[k] = v
missing = [i for i, k in enumerate(keys) if k not in existing]
body = "\n".join(f"  {json.dumps(k, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False)}," for k, v in sorted(existing.items(), key=lambda x: x[0].lower()))
open(target, "w").write(f"{header}export const {var}: Record<string, string> = {{\n{body}\n}};\n")
print(f"{os.path.basename(target)}: {len(existing)} traducciones; sin traducir: {len(missing)}")
for p in problems:
    print("  ⚠", p)
