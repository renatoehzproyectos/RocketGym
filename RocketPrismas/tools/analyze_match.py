#!/usr/bin/env python3
"""Analiza una partida grabada con Recorder.download() usando el rlcoach incluido.

    python tools/analyze_match.py                       # la grabación más reciente que encuentre
    python tools/analyze_match.py match-2026....prismas.json [--out carpeta]

Busca *.prismas.json en: la carpeta actual, la raíz de RocketPrismas y ~/Downloads.
Escribe el reporte (JSON + Markdown) en ./analysis por defecto.
Requiere Python 3.11+ y:  pip install jsonschema
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools" / "rlcoach" / "src"))


def is_recording(path: Path) -> bool:
    """Los reportes de rlcoach también terminan en .prismas.json; solo aceptamos grabaciones."""
    try:
        with path.open("rb") as fh:
            return b"rlcoach.prismas.recording" in fh.read(400)
    except OSError:
        return False


def newest_recording() -> Path | None:
    found: list[Path] = []
    for folder in {Path.cwd(), ROOT, Path.home() / "Downloads"}:
        if folder.is_dir():
            found.extend(p for p in folder.glob("*.prismas.json") if is_recording(p))
    return max(found, key=lambda p: p.stat().st_mtime) if found else None


def main() -> int:
    ap = argparse.ArgumentParser(description="Analiza una partida de RocketPrismas con rlcoach")
    ap.add_argument("recording", nargs="?", help="archivo *.prismas.json (por defecto, el más reciente)")
    ap.add_argument("--out", default="analysis", help="carpeta de salida (default: analysis)")
    args = ap.parse_args()

    path = Path(args.recording) if args.recording else newest_recording()
    if path is None or not path.is_file():
        print("No encontré ninguna grabación *.prismas.json. En el juego: Recorder.start() ... Recorder.download()")
        return 1
    try:
        from rlcoach.cli import main as rlcoach_main
    except ModuleNotFoundError as exc:
        print(f"Falta una dependencia ({exc.name}). Instala con:  pip install jsonschema")
        return 1

    print(f"Analizando {path} ...")
    return rlcoach_main(["report-md", str(path), "--adapter", "prismas", "--out", args.out])


if __name__ == "__main__":
    raise SystemExit(main())
