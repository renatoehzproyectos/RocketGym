#!/usr/bin/env bash
# Todas las pruebas del gimnasio. Requisitos: node 20+, python 3.11+, pytest; para test_cycle/test_ui: `npm i pyodide@0.26.4 jsdom@24` en $PYODIDE_DIR (default /tmp/pyo).
set -e
cd "$(dirname "$0")/../.."
node tools/gym/test_rules.mjs | tail -1
(cd tools/rlcoach && python3 -m pytest tests -q | tail -1)
node tools/gym/test_ui.mjs
node tools/gym/test_cycle.mjs | tail -1
