"""Tests for the RocketPrismas recording adapter (player vs bot)."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from rlcoach.cli import main as cli_main
from rlcoach.parser import get_adapter, list_adapters
from rlcoach.parser.errors import HeaderParseError, NetworkParseError
from rlcoach.report import generate_report
from rlcoach.schema import validate_report


def make_recording(seconds: float = 12.0, hz: float = 30.0) -> dict:
    """Synthetic 1v1: human (blue) chases the ball, bot (orange) idles."""
    frames = []
    n = int(seconds * hz)
    for i in range(n):
        t = i / hz
        ball_y = 600.0 * math.sin(t / 2)
        frames.append(
            {
                "t": round(t, 4),
                "ball": {
                    "p": [0.0, ball_y, 93.15],
                    "v": [0.0, 300 * math.cos(t / 2), 0.0],
                    "w": [0.0, 0.0, 0.0],
                },
                "cars": {
                    "human": {
                        "p": [-200.0, ball_y - 400.0, 17.0],
                        "v": [0.0, 900.0, 0.0],
                        "q": [0.0, 0.0, 0.7071, 0.7071],
                        "boost": max(0, 100 - i // 3),
                        "ground": True,
                        "in": {"throttle": 1.0, "steer": 0.0, "boost": i % 2 == 0},
                    },
                    "bot-1": {
                        "p": [200.0, 4000.0 - i * 5.0, 17.0],
                        "v": [0.0, -150.0, 0.0],
                        "r": [0.0, -math.pi / 2, 0.0],
                        "boost": 33,
                        "ground": True,
                    },
                },
            }
        )
    return {
        "format": "rlcoach.prismas.recording",
        "version": 1,
        "meta": {
            "map": "DFHStadium",
            "team_size": 1,
            "record_hz": hz,
            "match_guid": "test-guid-1",
            "duration": seconds,
        },
        "players": [
            {"id": "human", "name": "You", "team": 0, "is_bot": False},
            {
                "id": "bot-1",
                "name": "Nexto",
                "team": 1,
                "is_bot": True,
                "bot": "Nexto",
                "bot_rank": "Grand Champion",
            },
        ],
        "score": {"blue": 1, "orange": 0},
        "events": {
            "touches": [{"t": 2.0, "player": "human"}, {"t": 6.5, "player": "bot-1"}],
            "demos": [{"t": 8.0, "victim": "bot-1", "attacker": "human"}],
            "goals": [{"t": 10.0, "team": 0, "player": "human"}],
        },
        "frames": frames,
    }


@pytest.fixture
def recording_path(tmp_path: Path) -> Path:
    path = tmp_path / "match.prismas.json"
    path.write_text(json.dumps(make_recording()))
    return path


def test_adapter_registered():
    assert "prismas" in list_adapters()
    adapter = get_adapter("prismas")
    assert adapter.name == "prismas"
    assert adapter.supports_network_parsing


def test_header_marks_bots(recording_path: Path):
    header = get_adapter("prismas").parse_header(recording_path)
    assert header.team_size == 1
    assert (header.team0_score, header.team1_score) == (1, 0)
    assert header.match_length == pytest.approx(12.0)
    bot = next(p for p in header.players if p.name == "Nexto")
    assert bot.team == 1
    assert bot.stats["is_bot"] is True
    assert bot.stats["bot_rank"] == "Grand Champion"
    assert header.mutators["vs_bots"] is True
    assert header.mutators["bots"] == "Nexto"


def test_network_frames_and_events(recording_path: Path):
    adapter = get_adapter("prismas")
    nf = adapter.parse_network(recording_path)
    assert nf is not None and nf.diagnostics.status == "ok"
    assert nf.frame_count == 360
    assert nf.sample_rate == pytest.approx(30.0, rel=0.02)
    first = nf.frames[0]
    assert len(first.players) == 2
    human = next(p for p in first.players if p.team == 0)
    assert human.rotation.quaternion is not None
    assert human.throttle == 1.0
    touches = [e for f in nf.frames for e in f.parser_touch_events]
    assert [e.team for e in touches] == [0, 1]
    demos = [e for f in nf.frames for e in f.parser_demo_events]
    assert len(demos) == 1 and demos[0].victim_team == 1 and demos[0].attacker_team == 0


def test_report_end_to_end(recording_path: Path):
    report = generate_report(recording_path, adapter_name="prismas")
    assert "error" not in report
    validate_report(report)
    assert report["quality"]["parser"]["name"] == "prismas"
    assert report["metadata"]["playlist"] == "PRIVATE"
    assert not any(
        w.startswith("unrecognized_playlist") for w in report["quality"]["warnings"]
    )
    assert report["quality"]["parser"]["parsed_network_data"] is True
    names = {p["display_name"] for p in report["players"]}
    assert names == {"You", "Nexto"}
    # Parser-authored touches should be used rather than inferred ones.
    assert len(report["events"]["touches"]) >= 2


def test_cli_analyze(recording_path: Path, tmp_path: Path):
    out = tmp_path / "out"
    rc = cli_main(
        ["analyze", str(recording_path), "--adapter", "prismas", "--out", str(out)]
    )
    assert rc == 0
    assert list(out.glob("*.json"))


def test_rejects_wrong_format(tmp_path: Path):
    path = tmp_path / "bad.prismas.json"
    path.write_text(json.dumps({"format": "something-else", "version": 1}))
    with pytest.raises(HeaderParseError):
        get_adapter("prismas").parse_header(path)


def test_rejects_unsupported_version(tmp_path: Path):
    doc = make_recording(1.0)
    doc["version"] = 99
    path = tmp_path / "v.prismas.json"
    path.write_text(json.dumps(doc))
    with pytest.raises(HeaderParseError):
        get_adapter("prismas").parse_header(path)


def test_rejects_out_of_order_frames(tmp_path: Path):
    doc = make_recording(1.0)
    doc["frames"][5]["t"] = 0.0
    path = tmp_path / "o.prismas.json"
    path.write_text(json.dumps(doc))
    with pytest.raises(NetworkParseError):
        get_adapter("prismas").parse_network(path)


def test_non_recording_degrades_to_null_header(tmp_path: Path):
    """A real replay passed to this adapter must not crash adapter selection."""
    path = tmp_path / "x.replay"
    path.write_bytes(b"TAGame.Replay_Soccar_TA\x00" + b"\x00" * 11_000)
    adapter = get_adapter("prismas")
    assert adapter.parse_network(path) is None
