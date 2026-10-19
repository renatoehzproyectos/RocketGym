import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src"))
sys.path.insert(0, os.path.dirname(__file__))

from rlcoach.gym import analyze, evaluate_attempt, handle  # noqa: E402
from synth import build_doc  # noqa: E402

GOAL_BLUE = (0, -5150, 100)   # blue defends -Y


def _shot_doc(human_path, human_boost=60, extra_touches=(), ball_pre=None, duration=14.0):
    """Opponent (orange) shoots at blue's goal at t=10, goal at t=11.6. The human's path is the variable."""
    ball = ball_pre or [(0, (0, -1500, 93)), (10, (0, -1500, 93)), (11.6, GOAL_BLUE), (duration, GOAL_BLUE)]
    cars = {
        "human": {"team": 0, "path": human_path, "boost": human_boost},
        "bot-1": {"team": 1, "path": [(0, (0, -900, 17)), (9.9, (0, -1350, 17)), (duration, (0, -1350, 17))], "boost": 60},
    }
    touches = [{"t": 10.0, "player": "bot-1"}] + list(extra_touches)
    return build_doc(duration, ball, cars, goals=[{"t": 11.6, "team": 1, "player": "bot-1"}], touches=touches)


def test_out_of_position_is_found_and_ranked_first():
    # human camps far upfield (past the ball) the whole time
    doc = _shot_doc([(0, (0, 3000, 17)), (14, (0, 3000, 17))])
    r = analyze(doc)
    assert r["ok"] and r["conceded"] == 1
    top = r["top"]
    assert top["kind"] == "out_of_position"
    assert top["evidence"]["ahead_uu"] > 4000
    assert top["goal_t"] == pytest.approx(11.6)
    assert top["rank"] == 1 and top["impact"] >= 0.3


def test_scenario_is_restorable_and_precedes_the_error():
    doc = _shot_doc([(0, (0, 3000, 17)), (14, (0, 3000, 17))])
    top = analyze(doc)["top"]
    sc = top["scenario"]
    assert sc["t"] < top["t"]                                   # state is BEFORE the error
    assert 4.0 <= sc["window_s"] <= 12.0
    assert sc["goal_offset_s"] > sc["error_offset_s"] > 0
    ids = {c["id"] for c in sc["cars"]}
    assert ids == {"human", "bot-1"}
    human = next(c for c in sc["cars"] if c["human"])
    assert human["p"][1] == pytest.approx(3000, abs=1) and human["team"] == 0
    assert set(sc["ball"]) == {"p", "v"} and "yaw" in human and "boost" in human
    assert "ball_spin" in sc["fidelity"]["approx"]


def test_late_rotation_when_goalside_but_never_close():
    # human is goal-side of the ball (y=-3500 < -1500) but 4000 uu to the side the whole time
    doc = _shot_doc([(0, (4000, -3500, 17)), (14, (4000, -3500, 17))])
    kinds = [e["kind"] for e in analyze(doc)["errors"]]
    assert "late_rotation" in kinds and "out_of_position" not in kinds


def test_bad_touch_gives_the_ball_away():
    # human pokes the ball toward its own goal at t=8, opponent takes it at t=10 and scores
    ball = [(0, (0, -1500, 93)), (8, (0, -1500, 93)), (9.9, (0, -1700, 93)), (10, (0, -1700, 93)), (11.6, GOAL_BLUE)]
    human = [(0, (0, -1000, 17)), (7.9, (0, -1450, 17)), (8.3, (0, -1900, 17)), (14, (0, -1900, 17))]
    doc = _shot_doc(human, ball_pre=ball, extra_touches=[{"t": 8.0, "player": "human"}])
    r = analyze(doc)
    assert "bad_touch" in [e["kind"] for e in r["errors"]]


def test_own_goal_wins_and_is_not_duplicated_as_bad_touch():
    ball = [(0, (0, -1500, 93)), (8, (0, -1500, 93)), (9.6, GOAL_BLUE), (14, GOAL_BLUE)]
    cars = {"human": {"team": 0, "path": [(0, (0, -1300, 17)), (8, (0, -1450, 17)), (14, (0, -1450, 17))], "boost": 50},
            "bot-1": {"team": 1, "path": [(0, (0, 2000, 17)), (14, (0, 2000, 17))], "boost": 50}}
    doc = build_doc(14, ball, cars, goals=[{"t": 9.6, "team": 1, "player": "human"}], touches=[{"t": 8.0, "player": "human"}])
    errs = analyze(doc)["errors"]
    assert errs[0]["kind"] == "own_goal"
    assert [e["kind"] for e in errs].count("bad_touch") == 0


def test_teammate_goalside_means_no_out_of_position():
    doc = _shot_doc([(0, (0, 3000, 17)), (14, (0, 3000, 17))])
    # 2v2: add a blue teammate sitting goal-side of the ball
    doc["players"].append({"id": "bot-2", "name": "bot-2", "team": 0, "is_bot": True, "bot": "SimBot"})
    for f in doc["frames"]:
        f["cars"]["bot-2"] = {"p": [800, -3600, 17], "v": [0, 0, 0], "q": [0, 0, 0.7071, 0.7071], "boost": 50, "ground": True, "super": False}
    kinds = [e["kind"] for e in analyze(doc)["errors"]]
    assert "out_of_position" not in kinds


def test_every_conceded_goal_yields_a_lesson_and_ranking_is_sorted():
    doc = _shot_doc([(0, (0, 3000, 17)), (14, (0, 3000, 17))])
    r = analyze(doc)
    imp = [e["impact"] for e in r["errors"]]
    assert imp == sorted(imp, reverse=True) and r["errors"]


def test_boost_starved_enriches_the_primary_error():
    doc = _shot_doc([(0, (0, 3000, 17)), (14, (0, 3000, 17))], human_boost=4)
    top = analyze(doc)["top"]
    assert top["kind"] == "out_of_position" and top["evidence"].get("boost") == 4


def test_no_conceded_goals_returns_empty_but_ok():
    ball = [(0, (0, 0, 93)), (10, (0, 0, 93))]
    cars = {"human": {"team": 0, "path": [(0, (0, -500, 17)), (10, (0, -500, 17))]}, "bot-1": {"team": 1, "path": [(0, (0, 500, 17)), (10, (0, 500, 17))]}}
    r = analyze(build_doc(10, ball, cars))
    assert r["ok"] and r["errors"] == [] and r["top"] is None


# ------------------------------------------------------------------ attempts


def _attempt(human_path, goal=False, duration=6.0, touches=(), opp_touch_t=3.0, ball=None, boost=60):
    ball = ball or [(0, (0, -1500, 93)), (opp_touch_t, (0, -1500, 93)), (duration, (0, -1500, 93) if not goal else GOAL_BLUE)]
    cars = {"human": {"team": 0, "path": human_path, "boost": boost},
            "bot-1": {"team": 1, "path": [(0, (0, -900, 17)), (duration, (0, -900, 17))], "boost": 60}}
    doc = build_doc(duration, ball, cars, touches=[{"t": opp_touch_t, "player": "bot-1"}] + list(touches))
    doc["outcome"] = {"goal_against": goal}
    return doc


OOP = {"kind": "out_of_position", "t": 5.0, "goal_t": 11.6}


def test_attempt_corrected_when_goalside_and_no_goal():
    r = evaluate_attempt(OOP, _attempt([(0, (0, -3500, 17)), (6, (0, -3500, 17))]))
    assert r["corrected"] and "corrected" in r["reasons"] and r["score"] == 1.0


def test_attempt_fails_when_still_ahead_of_ball():
    r = evaluate_attempt(OOP, _attempt([(0, (0, 2500, 17)), (6, (0, 2500, 17))]))
    assert not r["corrected"] and "still_ahead_of_ball" in r["reasons"]


def test_attempt_fails_when_goal_conceded_even_if_positioned():
    r = evaluate_attempt(OOP, _attempt([(0, (0, -3500, 17)), (6, (0, -3500, 17))], goal=True))
    assert not r["corrected"] and "goal_conceded" in r["reasons"] and r["score"] < 0.5


def test_attempt_bad_touch_checks():
    bad = {"kind": "bad_touch", "t": 5.0, "goal_t": 9.0}
    never = evaluate_attempt(bad, _attempt([(0, (3000, 0, 17)), (6, (3000, 0, 17))]))
    assert not never["corrected"] and "never_touched_ball" in never["reasons"]
    ball = [(0, (0, -1500, 93)), (1.0, (0, -1500, 93)), (1.6, (0, -400, 93)), (6, (0, 1500, 93))]
    good = evaluate_attempt(bad, _attempt([(0, (0, -1900, 17)), (0.95, (0, -1450, 17)), (6, (0, 500, 17))],
                                           touches=[{"t": 1.0, "player": "human"}], ball=ball, opp_touch_t=5.9))
    assert good["corrected"], good


def test_attempt_boost_starved_needs_a_pickup():
    k = {"kind": "boost_starved", "t": 5.0, "goal_t": 9.0}
    flat = evaluate_attempt(k, _attempt([(0, (0, -3500, 17)), (6, (0, -3500, 17))], boost=4))
    assert not flat["corrected"] and "did_not_collect_boost" in flat["reasons"]
    got = evaluate_attempt(k, _attempt([(0, (0, -3500, 17)), (6, (0, -3500, 17))], boost=[(0, 4), (2, 4), (2.5, 70), (6, 70)]))
    assert got["corrected"]


def test_attempt_too_short_is_not_corrected():
    doc = _attempt([(0, (0, -3500, 17)), (0.01, (0, -3500, 17))], duration=0.01)
    assert not evaluate_attempt(OOP, doc)["corrected"]


def test_handle_roundtrip_and_errors_never_raise():
    doc = _shot_doc([(0, (0, 3000, 17)), (14, (0, 3000, 17))])
    out = json.loads(handle(json.dumps({"op": "analyze", "doc": doc})))
    assert out["ok"] and out["top"]["kind"] == "out_of_position"
    ev = json.loads(handle(json.dumps({"op": "evaluate", "error": out["top"], "attempt": _attempt([(0, (0, -3500, 17)), (6, (0, -3500, 17))])})))
    assert ev["corrected"]
    assert json.loads(handle("not json"))["ok"] is False
    assert json.loads(handle(json.dumps({"op": "nope"})))["ok"] is False


def test_lost_challenge_is_found_and_judged_in_attempts():
    # human touches first at t=8.0, the opponent wins the ball 0.4 s later 300 uu away, scores at t=11.6
    ball = [(0, (0, -1500, 93)), (8.0, (0, -1500, 93)), (8.5, (0, -1900, 93)), (10, (0, -1900, 93)), (11.6, GOAL_BLUE)]
    cars = {
        "human": {"team": 0, "path": [(0, (0, -1000, 17)), (7.9, (0, -2000, 17)), (8.4, (0, -2000, 17)), (14, (0, -2000, 17))], "boost": 60},
        "bot-1": {"team": 1, "path": [(0, (0, -900, 17)), (8.3, (0, -2300, 17)), (14, (0, -2300, 17))], "boost": 60},
    }
    doc = build_doc(14, ball, cars, goals=[{"t": 11.6, "team": 1, "player": "bot-1"}],
                    touches=[{"t": 8.0, "player": "human"}, {"t": 8.4, "player": "bot-1"}, {"t": 10.0, "player": "bot-1"}])
    r = analyze(doc)
    kinds = [e["kind"] for e in r["errors"]]
    assert "lost_challenge" in kinds, r["errors"]
    err = next(e for e in r["errors"] if e["kind"] == "lost_challenge")
    # the same bad 50/50 repeated in an attempt -> not corrected
    ball2 = [(0, (0, -1500, 93)), (2.0, (0, -1500, 93)), (2.5, (0, -1900, 93)), (6, (0, -1900, 93))]
    cars2 = {"human": {"team": 0, "path": [(0, (0, -1000, 17)), (1.9, (0, -2000, 17)), (6, (0, -2000, 17))], "boost": 60},
             "bot-1": {"team": 1, "path": [(0, (0, -900, 17)), (2.3, (0, -2300, 17)), (6, (0, -2300, 17))], "boost": 60}}
    again = build_doc(6, ball2, cars2, touches=[{"t": 2.0, "player": "human"}, {"t": 2.4, "player": "bot-1"}])
    again["outcome"] = {"goal_against": False}
    assert not evaluate_attempt(err, again)["corrected"]
    # winning it instead (opponent never retouches) -> corrected
    won = build_doc(6, ball2, cars2, touches=[{"t": 2.0, "player": "human"}])
    won["outcome"] = {"goal_against": False}
    assert evaluate_attempt(err, won)["corrected"]
