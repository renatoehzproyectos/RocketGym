#!/usr/bin/env python3
"""Genera webbots/gym_manifest.json: los archivos de rlcoach que el navegador (Pyodide) necesita para el gimnasio.

Se calcula importando rlcoach.gym en un intérprete limpio y listando lo que realmente se cargó, así que no hay
que mantener la lista a mano. Ejecutar tras tocar imports de rlcoach:   python tools/gym/build_manifest.py
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SRC = ROOT / "tools" / "rlcoach" / "src"

probe = r"""
import sys, json
sys.path.insert(0, %r)
import rlcoach.gym
print(json.dumps(sorted(m.__file__ for n, m in sys.modules.items() if n.split('.')[0] == 'rlcoach' and getattr(m, '__file__', None))))
""" % str(SRC)

files = json.loads(subprocess.check_output([sys.executable, "-c", probe], text=True))
rel = sorted(str(Path(f).resolve().relative_to(ROOT)).replace("\\", "/") for f in files)
# Pyodide no trae jsonschema: el gimnasio debe importar sin él. Prueba real (no heurística de texto).
guard = r"""
import sys, builtins
real = builtins.__import__
def blocked(name, *a, **k):
    if name.split('.')[0] == 'jsonschema':
        raise ImportError('jsonschema bloqueado')
    return real(name, *a, **k)
builtins.__import__ = blocked
sys.path.insert(0, %r)
import rlcoach.gym
""" % str(SRC)
res = subprocess.run([sys.executable, "-c", guard], capture_output=True, text=True)
if res.returncode:
    sys.exit("rlcoach.gym ya no importa sin jsonschema:\n" + res.stderr)
out = ROOT / "webbots" / "gym_manifest.json"
out.write_text(json.dumps({"root": "tools/rlcoach/src", "files": rel}, indent=1) + "\n", encoding="utf-8")
print(f"{len(rel)} archivos -> {out.relative_to(ROOT)}")
