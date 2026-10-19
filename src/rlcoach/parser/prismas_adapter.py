"""Parser adapter for RocketPrismas (RocketSim) match recordings.

RocketPrismas is a browser simulator, so there is no ``.replay`` file. A
recording is a JSON document (``*.prismas.json``) whose schema is documented in
``docs/prismas_recording_format.md``. This adapter converts it into the same
``Header`` / ``NetworkFrames`` structures the Rust adapter produces, so every
downstream stage (normalize, events, analyzers, reports) works unchanged.

Bots (RLBot-style opponents) are first-class: each recorded player may carry
``is_bot``, ``bot`` and ``bot_rank``; these are surfaced via
``PlayerInfo.stats`` and in the header ``mutators`` map.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from ..errors import ReplayFileNotFoundError
from ..utils.identity import build_player_identities
from .errors import HeaderParseError, NetworkParseError
from .interface import ParserAdapter
from .null_adapter import NullAdapter
from .types import (
    BallFrame,
    BoostPadEventFrame,
    Frame,
    GoalHeader,
    Header,
    NetworkDiagnostics,
    NetworkFrames,
    ParserDemoEvent,
    ParserKickoffMarker,
    ParserTouchEvent,
    PlayerFrame,
    PlayerInfo,
    Quaternion,
    Rotation,
    Vec3,
)

RECORDING_FORMAT = "rlcoach.prismas.recording"
SUPPORTED_VERSIONS = (1,)
RECORDING_SUFFIX = ".prismas.json"

_SUPERSONIC_SPEED = 2200.0  # uu/s, same threshold Rocket League uses


def is_prismas_recording(path: Path) -> bool:
    """Cheap check used by ingest to route recordings away from replay checks."""
    return str(path).lower().endswith(RECORDING_SUFFIX)


def _vec(value: Any, default: float = 0.0) -> Vec3:
    if isinstance(value, dict):
        value = [
            value.get("x", default),
            value.get("y", default),
            value.get("z", default),
        ]
    if not isinstance(value, (list, tuple)) or len(value) < 3:
        return Vec3(default, default, default)
    return Vec3(float(value[0]), float(value[1]), float(value[2]))


def _quat_to_euler(
    x: float, y: float, z: float, w: float
) -> tuple[float, float, float]:
    """(roll, pitch, yaw); mirrors parsers/rlreplay_rust ``quat_to_euler``."""
    roll = math.atan2(2.0 * (w * x + y * z), 1.0 - 2.0 * (x * x + y * y))
    sinp = 2.0 * (w * y - z * x)
    pitch = math.copysign(math.pi / 2, sinp) if abs(sinp) >= 1.0 else math.asin(sinp)
    yaw = math.atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z))
    return roll, pitch, yaw


def _rotation(car: dict[str, Any]) -> Rotation:
    quat = car.get("q")
    if isinstance(quat, (list, tuple)) and len(quat) == 4:
        qx, qy, qz, qw = (float(c) for c in quat)
        norm = math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw) or 1.0
        qx, qy, qz, qw = qx / norm, qy / norm, qz / norm, qw / norm
        roll, pitch, yaw = _quat_to_euler(qx, qy, qz, qw)
        return Rotation(
            pitch=pitch, yaw=yaw, roll=roll, quaternion=Quaternion(qx, qy, qz, qw)
        )
    euler = car.get("r")  # [pitch, yaw, roll] radians
    if isinstance(euler, (list, tuple)) and len(euler) == 3:
        return Rotation(
            pitch=float(euler[0]), yaw=float(euler[1]), roll=float(euler[2])
        )
    return Rotation(pitch=0.0, yaw=0.0, roll=0.0)


def _team(value: Any) -> int:
    if isinstance(value, str):
        return 1 if value.strip().lower() in ("orange", "1") else 0
    return 1 if int(value or 0) == 1 else 0


class PrismasAdapter(ParserAdapter):
    """Adapter that reads RocketPrismas ``*.prismas.json`` recordings."""

    def __init__(self) -> None:
        self._cache: tuple[str, dict[str, Any]] | None = None

    # -- interface ---------------------------------------------------------

    @property
    def name(self) -> str:
        return "prismas"

    @property
    def supports_network_parsing(self) -> bool:
        return True

    @property
    def backend_chain(self) -> list[str]:
        return ["prismas_json"]

    # -- in-memory documents ----------------------------------------------
    # The browser has no file to hand the adapter, so the gym passes the
    # recording document (the dict Recorder.stop() returns) straight in.

    def header_from_document(self, doc: dict[str, Any]) -> Header:
        _validate(doc, "<document>")
        return self._header(doc)

    def network_from_document(self, doc: dict[str, Any]) -> NetworkFrames | None:
        _validate(doc, "<document>")
        return self._network(doc)

    def parse_header(self, path: Path) -> Header:
        if not is_prismas_recording(Path(path)):
            # Not a recording (e.g. a real .replay): degrade like every other
            # adapter instead of failing, so adapter selection stays safe.
            return NullAdapter().parse_header(path)
        return self._header(self._load(path))

    def _header(self, doc: dict[str, Any]) -> Header:
        meta = doc.get("meta") or {}
        players_doc = doc["players"]
        score = doc.get("score") or {}
        frames = doc.get("frames") or []

        players: list[PlayerInfo] = []
        for p in players_doc:
            is_bot = bool(p.get("is_bot"))
            pid = str(p["id"])
            stats: dict[str, Any] = {"is_bot": is_bot}
            if is_bot:
                stats["bot"] = p.get("bot") or p.get("name")
                if p.get("bot_rank"):
                    stats["bot_rank"] = str(p["bot_rank"])
            players.append(
                PlayerInfo(
                    name=str(p.get("name") or pid),
                    platform_id=f"prismas:{pid}",
                    team=_team(p.get("team")),
                    score=int(p.get("score", 0) or 0),
                    platform_ids={"prismas": pid},
                    stats=stats,
                )
            )

        team_size = int(meta.get("team_size") or 0)
        if team_size <= 0:
            blue = sum(1 for p in players if p.team == 0)
            orange = sum(1 for p in players if p.team == 1)
            team_size = max(1, blue, orange)

        duration = float(meta.get("duration") or 0.0)
        if duration <= 0 and frames:
            duration = float(frames[-1].get("t", 0.0))

        goals = [
            GoalHeader(
                frame=_nearest_frame_index(frames, float(g.get("t", 0.0))),
                player_name=_player_name(players_doc, g.get("player")),
                player_team=_team(g.get("team")),
            )
            for g in (doc.get("events") or {}).get("goals", [])
        ]

        mutators: dict[str, str | int | float | bool] = {
            "source": "prismas",
            "vs_bots": any(p.get("is_bot") for p in players_doc),
        }
        bots = [
            str(p.get("bot") or p.get("name")) for p in players_doc if p.get("is_bot")
        ]
        if bots:
            mutators["bots"] = ",".join(bots)

        return Header(
            # Custom simulator matches map best to the schema's PRIVATE playlist.
            playlist_id="PRIVATE",
            map_name=str(meta.get("map") or "DFHStadium"),
            team_size=team_size,
            engine_build=str(meta.get("engine") or "rocketsim-web"),
            match_guid=str(meta.get("match_guid") or "") or None,
            declared_record_fps=float(meta.get("record_hz") or 0.0) or None,
            overtime=bool(meta.get("overtime", False)),
            mutators=mutators,
            team0_score=int(score.get("blue", 0) or 0),
            team1_score=int(score.get("orange", 0) or 0),
            match_length=duration,
            players=players,
            goals=goals,
            quality_warnings=["prismas_simulator_recording"],
        )

    def parse_network(self, path: Path) -> NetworkFrames | None:
        if not is_prismas_recording(Path(path)):
            return None
        return self._network(self._load(path))

    def _network(self, doc: dict[str, Any]) -> NetworkFrames | None:
        raw_frames = doc.get("frames") or []
        if not raw_frames:
            return NetworkFrames(
                frame_count=0,
                diagnostics=NetworkDiagnostics(
                    status="unavailable",
                    error_code="no_frames",
                    error_detail="recording contains no frames",
                    frames_emitted=0,
                    attempted_backends=self.backend_chain,
                ),
            )

        header = self._header(doc)
        canonical = {
            str(doc["players"][i]["id"]): identity.canonical_id
            for i, identity in enumerate(build_player_identities(header.players))
        }
        teams = {str(p["id"]): _team(p.get("team")) for p in doc["players"]}
        events = doc.get("events") or {}

        touches = _bucket(events.get("touches", []), raw_frames)
        demos = _bucket(events.get("demos", []), raw_frames)
        pads = _bucket(events.get("boost_pads", []), raw_frames)
        kickoffs = _bucket(events.get("kickoffs", []), raw_frames)

        frames: list[Frame] = []
        prev_t: float | None = None
        for idx, rf in enumerate(raw_frames):
            t = float(rf.get("t", 0.0))
            ball = rf.get("ball") or {}
            players: list[PlayerFrame] = []
            for pid, car in (rf.get("cars") or {}).items():
                pid = str(pid)
                if pid not in canonical:
                    continue
                players.append(self._player_frame(canonical[pid], teams[pid], car))

            frames.append(
                Frame(
                    timestamp=t,
                    ball=BallFrame(
                        position=_vec(ball.get("p")),
                        velocity=_vec(ball.get("v")),
                        angular_velocity=_vec(ball.get("w")),
                    ),
                    players=players,
                    boost_pad_events=[
                        BoostPadEventFrame(
                            pad_id=int(e.get("pad", -1)),
                            status=str(e.get("status", "COLLECTED")).upper(),
                            is_big=bool(e.get("big", False)),
                            player_id=canonical.get(str(e.get("player"))),
                            player_team=teams.get(str(e.get("player"))),
                            timestamp=float(e.get("t", t)),
                        )
                        for e in pads.get(idx, [])
                        if str(e.get("player")) in canonical or e.get("player") is None
                    ],
                    parser_touch_events=[
                        ParserTouchEvent(
                            timestamp=float(e.get("t", t)),
                            player_id=canonical[str(e["player"])],
                            team=teams[str(e["player"])],
                            frame_index=idx,
                            source="parser",
                        )
                        for e in touches.get(idx, [])
                        if str(e.get("player")) in canonical
                    ],
                    parser_demo_events=[
                        ParserDemoEvent(
                            timestamp=float(e.get("t", t)),
                            victim_id=canonical[str(e["victim"])],
                            attacker_id=canonical.get(str(e.get("attacker"))),
                            victim_team=teams[str(e["victim"])],
                            attacker_team=teams.get(str(e.get("attacker"))),
                            frame_index=idx,
                            source="parser",
                        )
                        for e in demos.get(idx, [])
                        if str(e.get("victim")) in canonical
                    ],
                    parser_kickoff_markers=[
                        ParserKickoffMarker(
                            timestamp=float(e.get("t", t)),
                            phase=str(e.get("phase", "start")),
                            frame_index=idx,
                            source="parser",
                        )
                        for e in kickoffs.get(idx, [])
                    ],
                    delta=None if prev_t is None else max(0.0, t - prev_t),
                )
            )
            prev_t = t

        duration = frames[-1].timestamp - frames[0].timestamp
        sample_rate = (
            (len(frames) - 1) / duration if duration > 0 and len(frames) > 1 else 30.0
        )
        return NetworkFrames(
            frame_count=len(frames),
            sample_rate=sample_rate,
            frames=frames,
            diagnostics=NetworkDiagnostics(
                status="ok",
                frames_emitted=len(frames),
                attempted_backends=self.backend_chain,
            ),
        )

    # -- helpers -----------------------------------------------------------

    @staticmethod
    def _player_frame(player_id: str, team: int, car: dict[str, Any]) -> PlayerFrame:
        vel = _vec(car.get("v"))
        speed = math.sqrt(vel.x**2 + vel.y**2 + vel.z**2)
        inputs = car.get("in") or {}
        boost = float(car.get("boost", 0.0))
        boost_active = inputs.get("boost")
        return PlayerFrame(
            player_id=player_id,
            team=team,
            position=_vec(car.get("p")),
            velocity=vel,
            rotation=_rotation(car),
            boost_amount=int(round(max(0.0, min(100.0, boost)))),
            angular_velocity=_vec(car["w"]) if "w" in car else None,
            throttle=_opt_float(inputs.get("throttle")),
            steer=_opt_float(inputs.get("steer")),
            handbrake=_opt_bool(inputs.get("handbrake")),
            boost_active=_opt_bool(boost_active),
            is_supersonic=bool(car.get("super", speed >= _SUPERSONIC_SPEED)),
            is_on_ground=bool(car.get("ground", True)),
            is_demolished=bool(car.get("demo", False)),
            is_jumping=_opt_bool(car.get("jumping")),
            is_dodging=_opt_bool(car.get("dodging")),
            is_double_jumping=_opt_bool(car.get("double_jumping")),
        )

    def _load(self, path: Path) -> dict[str, Any]:
        path = Path(path)
        key = str(path.resolve()) if path.exists() else str(path)
        if self._cache and self._cache[0] == key:
            return self._cache[1]
        if not path.exists():
            raise ReplayFileNotFoundError(str(path))
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise HeaderParseError(
                str(path), f"unreadable prismas recording: {exc}"
            ) from exc
        _validate(doc, str(path))
        self._cache = (key, doc)
        return doc


def _validate(doc: Any, path: str = "") -> None:
    if not isinstance(doc, dict) or doc.get("format") != RECORDING_FORMAT:
        raise HeaderParseError(path, f"not a {RECORDING_FORMAT} document")
    if doc.get("version") not in SUPPORTED_VERSIONS:
        raise HeaderParseError(
            path,
            f"unsupported recording version {doc.get('version')!r}; "
            f"supported: {SUPPORTED_VERSIONS}",
        )
    players = doc.get("players")
    if not isinstance(players, list) or not players:
        raise HeaderParseError(path, "recording has no players")
    ids = [str(p.get("id")) for p in players if isinstance(p, dict) and "id" in p]
    if len(ids) != len(players) or len(set(ids)) != len(ids):
        raise HeaderParseError(path, "every player needs a unique 'id'")
    frames = doc.get("frames")
    if frames is not None and not isinstance(frames, list):
        raise NetworkParseError(path, "'frames' must be a list")
    last = -1.0
    for f in frames or []:
        t = float(f.get("t", -1.0))
        if t < last:
            raise NetworkParseError(path, "frame timestamps must be non-decreasing")
        last = t


def _opt_float(value: Any) -> float | None:
    return None if value is None else float(value)


def _opt_bool(value: Any) -> bool | None:
    return None if value is None else bool(value)


def _player_name(players_doc: list[dict[str, Any]], pid: Any) -> str | None:
    for p in players_doc:
        if str(p.get("id")) == str(pid):
            return str(p.get("name") or p["id"])
    return None


def _nearest_frame_index(frames: list[dict[str, Any]], t: float) -> int | None:
    if not frames:
        return None
    return min(
        range(len(frames)), key=lambda i: abs(float(frames[i].get("t", 0.0)) - t)
    )


def _bucket(
    events: list[dict[str, Any]], frames: list[dict[str, Any]]
) -> dict[int, list[dict[str, Any]]]:
    """Group events by the frame whose timestamp is closest to the event time."""
    out: dict[int, list[dict[str, Any]]] = {}
    if not frames:
        return out
    times = [float(f.get("t", 0.0)) for f in frames]
    import bisect

    for e in events:
        t = float(e.get("t", 0.0))
        i = bisect.bisect_left(times, t)
        if i > 0 and (i == len(times) or abs(times[i - 1] - t) <= abs(times[i] - t)):
            i -= 1
        out.setdefault(i, []).append(e)
    return out
