# Bots en RocketPrismas
Todos corren dentro del navegador con Pyodide (Python en WASM): no hay que instalar nada.

Consola (F12) o URL:
- 1v1: `Bots.set({orange:['Nexto']})`
- 2v2: `Bots.set({blue:['PenguinBot'], orange:['Codename Cryo','Necto']})`
- URL: `?blue=PenguinBot&orange=Codename%20Cryo,Nexto%20(Toxic!)`
- Otros: `Bots.add('Element','orange')`, `Bots.clear()`, `Bots.list()`, `Bots.status()`

Tú eres siempre el auto azul. La primera vez de cada bot tarda unos segundos (Pyodide ~10 MB + pesos).
Element, Necto y Nexto corren sin PyTorch: pesos exportados a `.npz` y red reescrita en numpy.

## Orden y rango estimado

| Orden | Bot | Rango estimado |
|---:|---|---|
| 1 | SkyBot | Plata |
| 2 | Noob Blue | Plata–Oro |
| 3 | Noob Black | Oro |
| 4 | FillamentBot | Oro |
| 5 | Aether | Platino* |
| 6 | Isopod | Platino* |
| 7 | Oneborg | Platino* |
| 8 | Snek | Platino* |
| 9 | Zoomelette | Platino |
| 10 | FormularBot 1.5 | Platino |
| 11 | PenguinBot | Diamante* |
| 12 | Beast from the East | Diamante* |
| 13 | Codename Cryo | Diamante* |
| 14 | Element | Gran Campeón* |
| 15 | Necto | Gran Campeón* |
| 16 | Nexto | Gran Campeón |
| 17 | Nexto (Toxic!) | Gran Campeón |

## Grabar partidas para rlcoach (sin UI)
Después de que el bot cargue (`Bots.status()` → `ok: true`), por consola:
```js
Recorder.start({playerName: 'TuNombre'})   // jugador + bots, 30 Hz
// ... jugar ...
Recorder.download()                        // baja match-AAAAMMDD-HHMMSS.prismas.json
```
Análisis (rlcoach ya viene en `tools/rlcoach`; solo requiere Python 3.11+ y `pip install jsonschema`):
```
python tools/analyze_match.py match-....prismas.json   # sin argumento usa la grabación más reciente
```
Genera `analysis/*.json` y `analysis/*.md` (formato en `tools/rlcoach/docs/prismas_recording_format.md`). Un futuro modo contra bots solo debe llamar
`Recorder.start()` al empezar y `Recorder.download()` al terminar. El recorder solo lee el estado; no cambia el juego.
