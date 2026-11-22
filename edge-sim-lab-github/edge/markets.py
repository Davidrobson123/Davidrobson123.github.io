"""Markets are questions asked of the simulated games, and odds/edge maths.

Any bet = a boolean array over the sims (True where the bet wins). Combine arrays with &
for a same-game bet builder: correlation is kept because every leg reads the same sims.
"""
from __future__ import annotations
import numpy as np


# ---------- odds maths ----------
def dec_from_american(a):
    return 1 + (a / 100 if a > 0 else 100 / -a)


def dec_from_frac(s: str):
    n, d = s.split("/")
    return 1 + float(n) / float(d)


def frac_from_dec(d, max_den=20):
    from fractions import Fraction
    f = Fraction(d - 1).limit_denominator(max_den)
    return f"{f.numerator}/{f.denominator}"


def fair_dec(p):
    return np.inf if p <= 0 else 1 / p


def devig(decs, method="power"):
    """Remove the bookmaker margin from a full market (list of decimal odds)."""
    imp = np.array([1 / d for d in decs])
    if method == "mult":
        return imp / imp.sum()
    lo, hi = 0.5, 2.0            # power method: find k with sum(imp**k) == 1
    for _ in range(60):
        k = (lo + hi) / 2
        if (imp ** k).sum() > 1:
            lo = k
        else:
            hi = k
    return imp ** k


def edge(p, dec):
    """Expected profit per £1 staked."""
    return p * dec - 1


def kelly(p, dec, fraction=0.25):
    b = dec - 1
    f = (b * p - (1 - p)) / b
    return max(0.0, f * fraction)


# ---------- market readers ----------
def prob(mask):
    return float(np.mean(mask))


def moneyline(g, side="home"):
    m = g.margin
    win = (m > 0) if side == "home" else (m < 0)
    return prob(win) + 0.5 * prob(m == 0)


def spread(g, line, side="home"):
    """line from that side's view, e.g. home -6.5 -> line=-6.5."""
    m = g.margin if side == "home" else -g.margin
    return m + line > 0


def total(g, line, over=True):
    return g.total > line if over else g.total < line


def team_total(g, side, line, over=True):
    pts = g.home.pts if side == "home" else g.away.pts
    return pts > line if over else pts < line


def anytime_td(g, player):
    return g.player(player)["td"] >= 1


def player_line(g, player, stat, line, over=True):
    """stat in rush_yds, rec_yds, receptions; line like 64.5 (or 60 for '60+': pass line-0.5)."""
    v = g.player(player)[stat]
    return v > line if over else v < line


def summary(g):
    return {
        "home_win": moneyline(g, "home"), "away_win": moneyline(g, "away"),
        "exp_home_pts": float(g.home.pts.mean()), "exp_away_pts": float(g.away.pts.mean()),
        "fair_spread_home": -float(np.median(g.margin)), "mean_margin": float(g.margin.mean()),
        "fair_total": float(np.median(g.total)),
    }


def player_table(g, top=12):
    import pandas as pd
    rows = []
    for t in (g.home, g.away):
        for i, r in t.players.reset_index(drop=True).iterrows():
            td = t.rush_td_p[:, i] + t.rec_td_p[:, i]
            rows.append({"team": t.team, "player": r["name"], "pos": r["position"],
                         "anytime_td": float((td >= 1).mean()),
                         "fair_td_odds": round(1 / max((td >= 1).mean(), 1e-4), 2),
                         "rush_yds": float(np.median(t.rush_yds_p[:, i])),
                         "rec_yds": float(np.median(t.rec_yds_p[:, i])),
                         "receptions": float(t.rec_p[:, i].mean())})
    df = pd.DataFrame(rows).sort_values("anytime_td", ascending=False)
    return df.head(top) if top else df
