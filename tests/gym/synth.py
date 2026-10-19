"""Tiny builder for hand-made recordings: positions are piecewise-linear waypoints."""
from __future__ import annotations

import math


def lerp_path(points, t):
    """points: [(t, (x,y,z))...] sorted by t; linear interpolation, clamped at the ends."""
    if t <= points[0][0]:
        return list(points[0][1])
    for (t0, a), (t1, b) in zip(points, points[1:]):
        if t <= t1:
            k = (t - t0) / (t1 - t0) if t1 > t0 else 1.0
            return [a[i] + (b[i] - a[i]) * k for i in range(3)]
    return list(points[-1][1])


def velocity(points, t, h=0.05):
    a, b = lerp_path(points, t - h), lerp_path(points, t + h)
    return [(b[i] - a[i]) / (2 * h) for i in range(3)]


def quat_yaw(yaw):
    return [0.0, 0.0, round(math.sin(yaw / 2), 5), round(math.cos(yaw / 2), 5)]


def build_doc(duration, ball, cars, goals=(), touches=(), hz=30, team_of=None):
    """ball: waypoints; cars: {id: {"team": 0/1, "path": waypoints, "boost": float | [(t, v)...], "yaw": float, "bot": str|None}}"""
    players = []
    for pid, c in cars.items():
        p = {"id": pid, "name": pid, "team": c["team"], "is_bot": pid != "human"}
        if pid != "human":
            p["bot"] = c.get("bot", "SimBot")
        players.append(p)
    frames = []
    n = int(duration * hz)
    for i in range(n + 1):
        t = round(i / hz, 4)
        fr = {"t": t, "ball": {"p": lerp_path(ball, t), "v": velocity(ball, t), "w": [0, 0, 0]}, "cars": {}}
        for pid, c in cars.items():
            b = c.get("boost", 50)
            boost = b if isinstance(b, (int, float)) else lerp_path([(bt, (bv, 0, 0)) for bt, bv in b], t)[0]
            fr["cars"][pid] = {
                "p": lerp_path(c["path"], t),
                "v": velocity(c["path"], t),
                "q": quat_yaw(c.get("yaw", math.pi / 2 if c["team"] == 0 else -math.pi / 2)),
                "boost": boost,
                "ground": c.get("ground", True),
                "super": False,
            }
        frames.append(fr)
    score = {"blue": sum(1 for g in goals if g["team"] == 0), "orange": sum(1 for g in goals if g["team"] == 1)}
    return {
        "format": "rlcoach.prismas.recording",
        "version": 1,
        "meta": {"map": "DFHStadium", "team_size": max(1, sum(1 for c in cars.values() if c["team"] == 0)), "record_hz": hz,
                 "match_guid": "test", "duration": duration, "overtime": False, "engine": "rocketsim-web"},
        "players": players,
        "score": score,
        "events": {"goals": list(goals), "touches": list(touches)},
        "frames": frames,
    }
