# RocketPrismas recording format (`*.prismas.json`)

rlcoach analyzes RocketPrismas matches (including player vs bot) from a JSON
recording instead of a `.replay` file. Any future game mode only has to write
this file; no rlcoach changes are needed.

```bash
python -m rlcoach.cli analyze match.prismas.json --adapter prismas --out out --pretty
python -m rlcoach.cli report-md match.prismas.json --adapter prismas --out out
```

The file name **must end in `.prismas.json`** (that is how ingest skips the
binary-replay checks).

## Producing recordings (RocketPrismas)

RocketPrismas ships `recorder.js` (no UI). From the browser console, after the
bots have loaded (`Bots.status()` shows `ok: true`):

```js
Bots.set({orange: ['Nexto']})
Recorder.start({playerName: 'YourName'})   // 30 Hz by default
// ... play ...
Recorder.download()                        // saves match-YYYYMMDD-HHMMSS.prismas.json
```

A future vs-bots mode only needs to call `Recorder.start()` / `Recorder.download()`.
The recorder does not emit touches or demos (rlcoach infers them) or the
jumping/dodging flags (mechanics are inferred from motion); it attributes goals
to the last player who touched the ball.

## Schema (version 1)

```jsonc
{
  "format": "rlcoach.prismas.recording",   // required, exact
  "version": 1,                            // required
  "meta": {
    "map": "DFHStadium", "team_size": 1, "record_hz": 30,
    "match_guid": "uuid", "duration": 300.0, "overtime": false,
    "engine": "rocketsim-web", "playlist": "prismas_vs_bots"
  },
  "players": [                             // required, unique ids
    {"id": "human", "name": "You", "team": 0, "is_bot": false},
    {"id": "bot-1", "name": "Nexto", "team": 1, "is_bot": true,
     "bot": "Nexto", "bot_rank": "Grand Champion"}
  ],
  "score": {"blue": 2, "orange": 1},
  "frames": [                              // non-decreasing "t" (seconds)
    {"t": 0.0,
     "ball": {"p": [x,y,z], "v": [x,y,z], "w": [x,y,z]},
     "cars": {
       "human": {
         "p": [x,y,z], "v": [x,y,z], "w": [x,y,z],      // w optional
         "q": [qx,qy,qz,qw],                            // or "r": [pitch,yaw,roll] rad
         "boost": 0-100, "ground": true, "super": false, "demo": false,
         "in": {"throttle": -1..1, "steer": -1..1, "handbrake": false,
                "boost": false},                         // optional
         "jumping": false, "dodging": false, "double_jumping": false // optional
       }
     }}
  ],
  "events": {                              // all optional, "t" in seconds
    "touches":    [{"t": 2.0, "player": "human"}],
    "demos":      [{"t": 8.0, "victim": "bot-1", "attacker": "human"}],
    "goals":      [{"t": 10.0, "team": 0, "player": "human"}],
    "boost_pads": [{"t": 3.1, "pad": 12, "status": "COLLECTED",
                    "big": false, "player": "human"}],
    "kickoffs":   [{"t": 0.0, "phase": "start"}]
  }
}
```

## Notes

- **Units/axes**: Unreal units, same as Rocket League (x side wall ±4096,
  y back wall ±5120, z up). RocketSim already uses these; do not rescale.
  Blue = team 0 defends -y.
- **Rate**: 30 Hz is plenty; the measured rate is used if `record_hz` is off.
- **Touches/demos**: if provided, they are used as parser-authoritative
  events. If omitted, rlcoach falls back to its own inference from positions.
- **Boost pad IDs** must follow `schemas/boost_pad_tables.json` ordering;
  omit `boost_pads` if the sim's pad order differs (boost-pickup analysis is
  then inferred or partial).
- **Bots** are identified by `is_bot`/`bot`/`bot_rank`. They surface in report
  `metadata.mutators` (`vs_bots`, `bots`). Set your own display name in
  `rlcoach.toml` (`[identity]`) so "me" resolves to the human player.
- Rank benchmarks are calibrated on human ranks; treat bot rank as context.
