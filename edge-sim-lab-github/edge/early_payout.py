"""bet365 NFL Early Payout: a pre-match Money Line bet is paid as a winner if the team goes 17 points ahead
at any point. The simulator only produces final drive outcomes, so this module puts each team's scoring
drives in a random order within alternating possessions and tracks the running score.

Approximation (v1, 16 Nov 2026):
- each team gets `drives` possessions (default 11, about the league average); if a team scored on more
  drives than that, it gets one possession per score;
- possessions alternate, and a coin flip decides who has the first one;
- each team's TDs (7 points) and FGs (3) go into random slots among its possessions;
- defensive/special-teams TDs and overtime are ignored (overtime can't create a 17-point lead).
Use `ever_led_by` for the chance, and `ml_or_early` for "wins OR goes 17 up" (the real bet365 hit rate).
Check calibration with backtest_early_payout() before relying on it.
"""
from __future__ import annotations
import numpy as np


def _max_leads(g, drives=11, seed=0):
    rng = np.random.default_rng(seed)
    n = g.n
    h_td, h_fg, a_td, a_fg = (np.asarray(x, int) for x in (g.home.td, g.home.fg, g.away.td, g.away.fg))
    D = int(max(drives, (h_td + h_fg).max(), (a_td + a_fg).max()))
    def team_points(td, fg):
        # (n, D) array of points per possession, scores placed in random slots
        pts = np.zeros((n, D))
        pts[:, :] = 0
        keys = rng.random((n, D))
        order = np.argsort(keys, axis=1)                   # random permutation of slots per sim
        idx = np.arange(D)[None, :]
        val = np.where(idx < td[:, None], 7, np.where(idx < (td + fg)[:, None], 3, 0))
        np.put_along_axis(pts, order, val, axis=1)
        return pts
    hp, ap = team_points(h_td, h_fg), team_points(a_td, a_fg)
    home_first = rng.random(n) < 0.5
    # interleave: possession k of the first team, then possession k of the second
    first = np.where(home_first[:, None], hp, -ap)
    second = np.where(home_first[:, None], -ap, hp)
    seq = np.empty((n, 2 * D)); seq[:, 0::2] = first; seq[:, 1::2] = second
    run = np.cumsum(seq, axis=1)                           # home minus away after each possession
    return run.max(axis=1), -run.min(axis=1)              # biggest home lead, biggest away lead


def ever_led_by(g, side="home", k=17, drives=11, seed=0):
    """Boolean array over sims: did `side` lead by k+ points at some point?"""
    hmax, amax = _max_leads(g, drives, seed)
    return (hmax >= k) if side == "home" else (amax >= k)


def ml_or_early(g, side="home", k=17, drives=11, seed=0):
    """Boolean array: the bet365 Money Line pays (team wins, or leads by k+ at any point)."""
    m = g.margin if side == "home" else -g.margin
    return (m > 0) | ever_led_by(g, side, k, drives, seed)
