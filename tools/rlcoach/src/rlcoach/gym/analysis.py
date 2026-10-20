"""Error finding and attempt evaluation for the RocketPrismas gym.

Built on rlcoach's own stages: the Prismas parser adapter (in-memory document), frame
normalization, touch detection and 50/50 challenge detection. On top of those this module

  * finds the mistakes behind every goal the player's team conceded,
  * ranks them by impact and picks the highest-impact one,
  * builds a *scenario*: the exact game state shortly before the mistake, in the form the
    simulator can restore (ball position/velocity, every car's position/yaw/velocity/boost),
  * judges a later practice attempt against the original mistake.

Everything is pure Python on JSON-able dicts so it runs unchanged in CPython (CLI, tests)
and in Pyodide (the browser gym).

Conventions: blue (team 0) defends -Y and attacks +Y; orange is the mirror image.
Times are seconds from the start of the recording ("t" in the recording document).
"""

from __future__ import annotations

import bisect
import json
import math
from typing import Any

from ..events.challenges import detect_challenge_events
from ..events.touches import detect_touches
from ..normalize import build_timeline
from ..parser.prismas_adapter import PrismasAdapter
from ..utils.identity import build_player_identities

BACK_WALL_Y = 5120.0
GOAL_HALF_WIDTH = 892.755
GOAL_HEIGHT = 642.775

# Per-kind tuning: base severity, and how many seconds before the mistake the scenario starts
# (the player needs a moment of "normal play" to make the decision again).
KINDS: dict[str, dict[str, Any]] = {
    "own_goal": {"base": 1.00, "lead": 2.0},
    "out_of_position": {"base": 0.90, "lead": 2.2},
    "bad_touch": {"base": 0.85, "lead": 1.6},
    "lost_challenge": {"base": 0.80, "lead": 1.6},
    "late_rotation": {"base": 0.70, "lead": 2.5},
    "boost_starved": {"base": 0.40, "lead": 3.0},
    "defensive_lapse": {"base": 0.35, "lead": 2.5},
}
IMPORTANT_IMPACT = 0.30
MAX_ERRORS = 4
MIN_WINDOW_S = 4.0
MAX_WINDOW_S = 12.0


# --------------------------------------------------------------------------- timeline helpers


class _Timeline:
    """Normalized frames plus fast time lookup."""

    def __init__(self, frames: list[Any]) -> None:
        self.frames = frames
        self.times = [f.timestamp for f in frames]

    def index(self, t: float) -> int:
        i = bisect.bisect_left(self.times, t)
        if i <= 0:
            return 0
        if i >= len(self.times):
            return len(self.times) - 1
        return i if abs(self.times[i] - t) < abs(self.times[i - 1] - t) else i - 1

    def car(self, pid: str, t: float):
        for p in self.frames[self.index(t)].players:
            if p.player_id == pid:
                return p
        return None

    def ball(self, t: float):
        return self.frames[self.index(t)].ball


def _canonical_ids(doc: dict[str, Any], header: Any) -> dict[str, str]:
    return {
        str(doc["players"][i]["id"]): ident.canonical_id
        for i, ident in enumerate(build_player_identities(header.players))
    }


def _speed(v: Any) -> float:
    return math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)


def _dist(a: Any, b: Any) -> float:
    return math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)


def _side(team: int) -> float:
    """+1 for blue (attacks +Y), -1 for orange. Multiply a Y to get 'upfield' as positive."""
    return 1.0 if team == 0 else -1.0


def _ahead_of_ball(player: Any, ball: Any, team: int) -> float:
    """Uu by which the player is upfield of the ball (positive = past the ball, i.e. not goal-side)."""
    return (player.position.y - ball.position.y) * _side(team)


# --------------------------------------------------------------------------- goals / context


def _conceded_goals(doc: dict[str, Any], team: int) -> list[dict[str, Any]]:
    """Goals the player's team conceded, with running score and the 'decisive' flag."""
    run = [0, 0]
    out: list[dict[str, Any]] = []
    for g in sorted((doc.get("events") or {}).get("goals", []), key=lambda g: float(g["t"])):
        before = run[team] - run[1 - team]
        run[int(g["team"])] += 1
        after = run[team] - run[1 - team]
        if int(g["team"]) != team:
            out.append({"t": float(g["t"]), "scorer": g.get("player"), "before": before, "after": after})
    # decisive = the last time the player's team fell from "not behind" to "behind"
    decisive = None
    for i, g in enumerate(out):
        if g["before"] >= 0 and g["after"] < 0:
            decisive = i
    for i, g in enumerate(out):
        g["decisive"] = (i == decisive) or (decisive is None and i == len(out) - 1)
    return out


def _touch_chain(touches: list[Any], tg: float, team_of: dict[str, int], team: int) -> dict[str, Any]:
    """Last own-team touch and the opposing touch chain leading to a goal at time tg."""
    before = [t for t in touches if t.t <= tg + 0.05]
    shot = before[-1] if before else None
    chain_start = None
    last_own = None
    for t in reversed(before):
        if team_of.get(t.player_id) == team:
            last_own = t
            break
        chain_start = t
    return {"shot": shot, "chain_start": chain_start, "last_own": last_own}


# --------------------------------------------------------------------------- detectors


def _impact(kind: str, t_err: float, tg: float, decisive: bool) -> float:
    base = KINDS[kind]["base"]
    time_w = max(0.35, min(1.0, math.exp(-max(0.0, tg - t_err) / 6.0)))
    goal_w = 1.0 if decisive else 0.78
    return round(base * time_w * goal_w, 3)


def _detect_for_goal(
    tl: _Timeline,
    touches: list[Any],
    challenges: list[Any],
    goal: dict[str, Any],
    pid: str,
    team: int,
    team_of: dict[str, int],
    mates: list[str],
) -> list[dict[str, Any]]:
    tg = goal["t"]
    ch = _touch_chain(touches, tg, team_of, team)
    shot = ch["shot"]
    errors: list[dict[str, Any]] = []

    def add(kind: str, t_err: float, why: str, hint: str, evidence: dict[str, Any]) -> None:
        t_err = max(0.0, t_err)
        errors.append(
            {
                "kind": kind,
                "t": round(t_err, 3),
                "goal_t": round(tg, 3),
                "decisive_goal": bool(goal["decisive"]),
                "impact": _impact(kind, t_err, tg, goal["decisive"]),
                "why": why,
                "hint": hint,
                "evidence": evidence,
            }
        )

    # 1) own goal: the player was the last to touch the ball before it went in
    if shot is not None and shot.player_id == pid and tg - shot.t < 2.5:
        add(
            "own_goal",
            shot.t - 0.3,
            "The last touch before the goal was yours, and it went into your own net.",
            "Take the touch away from your goal: aim wide of the net or up the wall.",
            {"touch_t": round(shot.t, 2)},
        )

    t_shot = shot.t if shot is not None else tg - 1.0

    # 2) out of position: past the ball (nobody goal-side) while the opponents attack
    mates_back = False
    me_at_shot = tl.car(pid, t_shot)
    ball_at_shot = tl.ball(t_shot)
    if me_at_shot is not None:
        for m in mates:
            mp = tl.car(m, t_shot)
            if mp is not None and _ahead_of_ball(mp, ball_at_shot, team) < -200:
                mates_back = True
        ahead = _ahead_of_ball(me_at_shot, ball_at_shot, team)
        if ahead > 400 and not mates_back and shot is not None and shot.player_id != pid:
            # walk back to the moment the player went past the ball and stayed there
            t_err = t_shot
            i = tl.index(t_shot)
            while i > 0 and tl.times[i] > t_shot - 6.0:
                p = next((x for x in tl.frames[i].players if x.player_id == pid), None)
                if p is None or _ahead_of_ball(p, tl.frames[i].ball, team) <= 150:
                    break
                t_err = tl.times[i]
                i -= 1
            add(
                "out_of_position",
                t_err,
                f"You were {int(ahead)} uu upfield of the ball with nobody goal-side when the shot came.",
                "Rotate back behind the ball earlier: be goal-side before the opponent gets the shot.",
                {"ahead_uu": round(ahead), "shot_t": round(t_shot, 2), "teammate_back": mates_back},
            )

    # 3) bad touch: your touch handed the ball to the attack
    lo = ch["last_own"]
    if lo is not None and lo.player_id == pid and 0.0 < tg - lo.t < 8.0:
        after = tl.ball(lo.t + 0.5)
        toward_own = after.velocity.y * _side(team) < -300
        gave_away = ch["chain_start"] is not None and ch["chain_start"].t - lo.t < 2.5
        if toward_own or gave_away:
            add(
                "bad_touch",
                lo.t - 0.2,
                "Your touch left the ball with the opponents."
                if gave_away
                else "Your touch sent the ball back toward your own goal.",
                "Clear it with direction: to the corner or up the wall, away from the middle.",
                {"touch_t": round(lo.t, 2), "ball_vy_after": round(after.velocity.y * _side(team))},
            )

    # 4) lost 50/50 in the build-up to the goal
    for c in challenges:
        if not (tg - 9.0 <= c.t <= tg):
            continue
        mine = c.first_player == pid or c.second_player == pid
        if not mine:
            continue
        outcome = c.outcome if c.first_player == pid else {"WIN": "LOSS", "LOSS": "WIN"}.get(c.outcome, c.outcome)
        if outcome == "LOSS":
            add(
                "lost_challenge",
                c.t - 0.4,
                "You lost the 50/50 and the opponents attacked from it.",
                "Commit only when you can win it; otherwise hold your line and cover.",
                {"challenge_t": round(c.t, 2), "risk": round(c.risk_first if c.first_player == pid else c.risk_second, 2)},
            )
            break

    # 5) never got to the shot: far from the ball for the whole attack
    if me_at_shot is not None and shot is not None and shot.player_id != pid:
        closest = min(
            (_dist(p.position, f.ball.position) for f in tl.frames[tl.index(t_shot) : tl.index(tg) + 1] for p in f.players if p.player_id == pid),
            default=None,
        )
        d_shot = _dist(me_at_shot.position, ball_at_shot.position)
        if closest is not None and closest > 600 and d_shot > 1100 and not any(e["kind"] == "out_of_position" for e in errors):
            add(
                "late_rotation",
                t_shot - 1.5,
                f"You never got within {int(closest)} uu of the ball before the goal.",
                "Read the attack early and cut the angle: get on the shot line, not behind it.",
                {"closest_uu": round(closest), "dist_at_shot_uu": round(d_shot)},
            )

    # 6) running on empty while defending
    if me_at_shot is not None:
        b = tl.car(pid, t_shot - 1.0)
        if b is not None and b.boost_amount <= 12:
            add(
                "boost_starved",
                t_shot - 1.0,
                f"You had {b.boost_amount} boost going into the defence.",
                "Take small pads on your way back so you can reach the ball when it matters.",
                {"boost": b.boost_amount},
            )

    # the same moment must not teach two lessons: the more specific diagnosis wins
    for loser, winner_kinds in (("bad_touch", ("own_goal", "lost_challenge")), ("lost_challenge", ("own_goal",))):
        wins = [e for e in errors if e["kind"] in winner_kinds]
        errors = [e for e in errors if not (e["kind"] == loser and any(abs(e["t"] - w["t"]) < 1.5 for w in wins))]

    # fallback: a conceded goal always teaches something
    if not errors:
        add(
            "defensive_lapse",
            t_shot - 1.0,
            "The goal came with no clear single cause; this is the last moment you could still have changed it.",
            "Check your position relative to the ball and the opponent every time possession changes.",
            {"shot_t": round(t_shot, 2)},
        )
    return errors


# --------------------------------------------------------------------------- scenario


def _yaw_of(p: Any) -> float:
    return float(p.rotation.yaw)


def _scenario(tl: _Timeline, doc: dict[str, Any], canon: dict[str, str], error: dict[str, Any], pid: str) -> dict[str, Any]:
    """Game state shortly before the mistake, in the form the simulator can restore."""
    kind = error["kind"]
    t_state = max(0.0, error["t"] - KINDS[kind]["lead"])
    me_c = canon[pid]
    # prefer a moment when the player is on the ground (the sim can only restore a level car)
    i0 = tl.index(t_state)
    chosen, airborne = i0, True
    for i in range(i0, max(-1, i0 - 90), -1):
        p = next((x for x in tl.frames[i].players if x.player_id == me_c), None)
        if p is not None and p.is_on_ground:
            chosen, airborne = i, False
            break
    f = tl.frames[chosen]
    cars = []
    for p_doc in doc["players"]:
        cid = canon[str(p_doc["id"])]
        p = next((x for x in f.players if x.player_id == cid), None)
        if p is None:
            continue
        cars.append(
            {
                "id": str(p_doc["id"]),
                "team": int(p_doc.get("team", 0)),
                "human": str(p_doc["id"]) == pid,
                "bot": p_doc.get("bot"),
                "p": [round(p.position.x, 1), round(p.position.y, 1), round(p.position.z, 1)],
                "v": [round(p.velocity.x, 1), round(p.velocity.y, 1), round(p.velocity.z, 1)],
                "yaw": round(_yaw_of(p), 4),
                "boost": float(p.boost_amount),
                "ground": bool(p.is_on_ground),
            }
        )
    t_state = tl.times[chosen]
    window = max(MIN_WINDOW_S, min(MAX_WINDOW_S, (error["goal_t"] - t_state) + 2.0))
    ball = f.ball
    return {
        "t": round(t_state, 3),
        "window_s": round(window, 2),
        "error_offset_s": round(error["t"] - t_state, 3),
        "goal_offset_s": round(error["goal_t"] - t_state, 3),
        "ball": {
            "p": [round(ball.position.x, 1), round(ball.position.y, 1), round(ball.position.z, 1)],
            "v": [round(ball.velocity.x, 1), round(ball.velocity.y, 1), round(ball.velocity.z, 1)],
        },
        "cars": cars,
        # honest about what the simulator cannot restore: ball spin, car pitch/roll/spin, flip state
        "fidelity": {"airborne": airborne, "approx": ["ball_spin", "car_pitch_roll", "car_spin", "flip_state"]},
    }


# --------------------------------------------------------------------------- public API


def analyze(doc: dict[str, Any], player_id: str = "human", *, max_errors: int = MAX_ERRORS) -> dict[str, Any]:
    """Analyze a recording of a match the player played. Returns ranked, practiceable errors."""
    adapter = PrismasAdapter()
    header = adapter.header_from_document(doc)
    net = adapter.network_from_document(doc)
    if net is None or not net.frames:
        return {"ok": False, "error": "no_frames", "errors": []}
    frames = build_timeline(header, net.frames)
    tl = _Timeline(frames)
    canon = _canonical_ids(doc, header)
    me_c = canon[player_id]
    team_of = {canon[str(p["id"])]: int(p.get("team", 0)) for p in doc["players"]}
    team = team_of[me_c]
    mates = [c for c, t in team_of.items() if t == team and c != me_c]

    touches = detect_touches(frames)
    challenges = detect_challenge_events(frames, touches)
    goals = _conceded_goals(doc, team)

    found: list[dict[str, Any]] = []
    for gi, g in enumerate(goals):
        per_goal = _detect_for_goal(tl, touches, challenges, g, me_c, team, team_of, mates)
        per_goal.sort(key=lambda e: -e["impact"])
        primary = per_goal[0]
        # one extra lesson per goal at most, and never a restatement of the same moment
        extra = [
            e
            for e in per_goal[1:]
            if e["kind"] != "boost_starved" and e["impact"] >= 0.55 * primary["impact"] and abs(e["t"] - primary["t"]) >= 1.5
        ]
        keep = [primary] + extra[:1]
        # a low-boost note enriches the main error instead of becoming a separate lesson
        for e in per_goal:
            if e["kind"] == "boost_starved" and e is not primary:
                primary["evidence"]["boost"] = e["evidence"]["boost"]
        for e in keep:
            e["goal_index"] = gi
        found.extend(keep)

    found.sort(key=lambda e: -e["impact"])
    # drop near-duplicates (same kind within 3 s)
    unique: list[dict[str, Any]] = []
    for e in found:
        if not any(u["kind"] == e["kind"] and abs(u["t"] - e["t"]) < 3.0 for u in unique):
            unique.append(e)
    important = [e for e in unique if e["impact"] >= IMPORTANT_IMPACT][:max_errors] or unique[:1]
    for rank, e in enumerate(important, start=1):
        e["rank"] = rank
        e["id"] = f"err{rank}-{e['kind']}-{int(e['t'] * 1000)}"
        e["scenario"] = _scenario(tl, doc, canon, e, player_id)

    score = doc.get("score") or {}
    mine, theirs = int(score.get("blue" if team == 0 else "orange", 0)), int(score.get("orange" if team == 0 else "blue", 0))
    return {
        "ok": True,
        "player_id": player_id,
        "team": team,
        "score": {"player": mine, "opponent": theirs},
        "conceded": len(goals),
        "errors": important,
        "top": important[0] if important else None,
        "sample_rate": net.sample_rate,
    }


# --------------------------------------------------------------------------- attempt evaluation


def evaluate_attempt(error: dict[str, Any], attempt: dict[str, Any], player_id: str = "human") -> dict[str, Any]:
    """Was the original mistake corrected in this practice attempt?

    `attempt` is a recording document of the attempt (t = 0 at the restored state) plus the key
    "outcome": {"goal_against": bool}, which the gym fills from the game's own goal detection.
    Returns {"corrected": bool, "score": 0..1, "reasons": [...], "metrics": {...}}.
    """
    kind = error["kind"]
    adapter = PrismasAdapter()
    header = adapter.header_from_document(attempt)
    net = adapter.network_from_document(attempt)
    if net is None or len(net.frames) < 2:
        return {"corrected": False, "score": 0.0, "reasons": ["attempt_too_short"], "metrics": {}}
    frames = build_timeline(header, net.frames)
    tl = _Timeline(frames)
    canon = _canonical_ids(attempt, header)
    me_c = canon[player_id]
    team_of = {canon[str(p["id"])]: int(p.get("team", 0)) for p in attempt["players"]}
    team = team_of[me_c]
    touches = detect_touches(frames)
    challenges = detect_challenge_events(frames, touches)
    mates = [c for c, t in team_of.items() if t == team and c != me_c]

    goal_against = bool((attempt.get("outcome") or {}).get("goal_against")) or any(
        int(g["team"]) != team for g in (attempt.get("events") or {}).get("goals", [])
    )
    my_touches = [t for t in touches if t.player_id == me_c]
    opp_touches = [t for t in touches if team_of.get(t.player_id) != team]
    reasons: list[str] = []
    metrics: dict[str, Any] = {"goal_against": goal_against, "my_touches": len(my_touches)}
    ok = not goal_against
    if goal_against:
        reasons.append("goal_conceded")

    if kind in ("out_of_position", "own_goal", "defensive_lapse"):
        worst = 0.0
        for t in opp_touches:
            me = tl.car(me_c, t.t)
            if me is None:
                continue
            b = tl.ball(t.t)
            ahead = _ahead_of_ball(me, b, team)
            back = any((tl.car(m, t.t) is not None and _ahead_of_ball(tl.car(m, t.t), b, team) < -200) for m in mates)
            if not back:
                worst = max(worst, ahead)
        metrics["max_ahead_uu"] = round(worst)
        if worst > 400:
            ok = False
            reasons.append("still_ahead_of_ball")
        if kind == "own_goal" and any(
            tl.ball(t.t + 0.5).velocity.y * _side(team) < -300 for t in my_touches
        ):
            ok = False
            reasons.append("touch_toward_own_goal")
    elif kind == "lost_challenge":
        lost = False
        for c in challenges:
            mine = c.first_player == me_c or c.second_player == me_c
            if not mine:
                continue
            out = c.outcome if c.first_player == me_c else {"WIN": "LOSS", "LOSS": "WIN"}.get(c.outcome, c.outcome)
            lost = lost or out == "LOSS"
        metrics["lost_challenge"] = lost
        if lost:
            ok = False
            reasons.append("lost_challenge_again")
    elif kind == "bad_touch":
        bad = False
        for t in my_touches:
            after = tl.ball(t.t + 0.5)
            nxt = next((o for o in opp_touches if 0 < o.t - t.t < 2.5), None)
            if after.velocity.y * _side(team) < -300 or nxt is not None:
                bad = True
        metrics["bad_touch"] = bad
        if not my_touches:
            ok = False
            reasons.append("never_touched_ball")
        elif bad:
            ok = False
            reasons.append("touch_gave_possession")
    elif kind == "late_rotation":
        closest = min((_dist(p.position, f.ball.position) for f in frames for p in f.players if p.player_id == me_c), default=1e9)
        metrics["closest_uu"] = round(closest)
        if closest > 600 and not my_touches:
            ok = False
            reasons.append("never_reached_ball")
    elif kind == "boost_starved":
        series = [p.boost_amount for f in frames for p in f.players if p.player_id == me_c]
        gain = (max(series) - series[0]) if series else 0
        metrics["boost_gain"] = gain
        if gain < 15:
            ok = False
            reasons.append("did_not_collect_boost")

    # simple 0..1 score: goal conceded is the heaviest signal, then the kind-specific check
    score = 1.0
    if goal_against:
        score -= 0.6
    score -= 0.4 * (len([r for r in reasons if r != "goal_conceded"]) > 0)
    if ok:
        reasons.append("corrected")
    return {"corrected": bool(ok), "score": round(max(0.0, score), 2), "reasons": reasons, "metrics": metrics, "kind": kind}


# --------------------------------------------------------------------------- worker entry point


def handle(request_json: str) -> str:
    """JSON in / JSON out, the single entry point the Pyodide worker calls."""
    try:
        req = json.loads(request_json)
        op = req["op"]
        if op == "analyze":
            out = analyze(req["doc"], req.get("player_id", "human"))
        elif op == "evaluate":
            out = evaluate_attempt(req["error"], req["attempt"], req.get("player_id", "human"))
        else:
            out = {"ok": False, "error": f"unknown op {op!r}"}
    except Exception as exc:  # the worker must always answer
        out = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    return json.dumps(out)
