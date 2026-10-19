"""Gym: turns a lost player-vs-bot match recording into a ranked list of practiceable mistakes."""

from .analysis import analyze, evaluate_attempt, handle

__all__ = ["analyze", "evaluate_attempt", "handle"]
