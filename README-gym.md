# Gym (play → lose → fix the exact mistake → prove it)

Start menu → **GYM (BOTS + COACH)**. Pick a rank (Silver…Grand Champion: the ranks that have bots) and 1v1 / 2v2 / 3v3.

## The loop
1. **Match**: 5:00, overtime (golden goal) if tied. You + bot teammates vs bots picked from the ladder in `webbots/manifest.json`.
2. **Forfeit rule**: a 4-goal lead ends the match. It is a `MatchRules` state transition (`ended`, `reason: 'forfeit'`, `frozen`) and
   also blocks game.js's automatic kickoff (`SIM.holdKickoff`), so nothing can reopen the match. It applies to both teams.
3. **Win by 2+ (or forfeit)** → next, stronger bot. A narrow win keeps the same bot. A loss starts the review.
4. **Review**: the replay (recorder.js, 30 Hz, with real touches) goes to **rlcoach in Pyodide** (`tools/rlcoach/src/rlcoach/gym/analysis.py`).
   It finds mistakes behind each goal conceded, ranks them by impact and builds a scenario for each.
5. **Practice**: the exact state before the mistake is restored (ball pos/vel; every car pos, yaw, vel, boost). Speeds 0.25 / 0.5 / 0.75 / 1x.
6. **Demo (optional)**: a bot of exactly one *available* rank above your effective rank drives your car; then you are put back at the same start state.
   Effective rank = max(selected rank, rank of the strongest bot you beat convincingly).
7. **Attempt** → rlcoach judges whether *that* mistake is fixed (no goal conceded + a check specific to the mistake kind).
8. After the key mistakes: **rematch** against the bot/team that beat you. Repeat.

Mistake kinds: own_goal, out_of_position, bad_touch, lost_challenge, late_rotation, boost_starved, defensive_lapse.
Progress and the review are saved in localStorage; the last replay in IndexedDB (button *Save replay* exports `.prismas.json` for `tools/analyze_match.py`).

## Known limits
- The physics module cannot set ball spin or car pitch/roll/spin/flip state. Restored cars are level with the recorded yaw; scenarios record `fidelity.airborne`.
- "Touch" = sudden ball velocity change with a car within reach (recorder heuristic).
- Evaluation is heuristic: it checks for the original failure, not for "optimal play".

## Tests (`tools/gym/run_tests.sh`)
rules (18), analysis + adapter (26), UI smoke under jsdom, and a full headless cycle with the real wasm physics, recorder, rules, core and rlcoach-in-Pyodide.
`node tools/gym/match_sim.mjs 2` produces a recording from the real physics; `node tools/gym/run_worker_node.mjs <file>` runs the real worker on it.
After editing rlcoach imports: `python tools/gym/build_manifest.py`.

## Audio
`audio.js` (solo lectura sobre `RS`) usa el pack RocketLeague-Audio (dominio público, ver `audio/LICENSE-RocketLeague-Audio.txt`). Se cargan 27 sonidos (~1 MB) desde `audio/`:
motor en 3 capas de RPM (tono según velocidad), boost (inicio/bucle/fin), derrape, salto/flip/aterrizaje, golpes por intensidad (balón y pared), gol + hinchada, cuenta atrás, y clics/aciertos de la interfaz.
- Botón 🔊 (arriba a la derecha) cicla 100% / 55% / 25% / mute; tecla **M** silencia. `?audio=0` lo desactiva.
- El pack original no se incluye (483 MB). Para cambiar un sonido: edita `MAP` en `tools/audio/build_audio.py` y ejecuta `python tools/audio/build_audio.py /ruta/RocketLeague-Audio-main`.
- Los archivos del pack tienen nombres numerados; la asignación se hizo por análisis de forma de onda (envolvente, espectro), no de oído. Si alguno no suena bien, cámbialo en `MAP`.
- Los bots y el rival multijugador no tienen sonido de motor propio (solo el auto local).
