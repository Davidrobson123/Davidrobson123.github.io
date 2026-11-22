"""Game logs, TD hit rates and snap shares for display next to the projections (so they can be checked)."""
from __future__ import annotations
import os
import pandas as pd
from . import data

SNAP_FILE = ("snap_counts/snap_counts_{y}.parquet", "snap{y}.parquet")


def _snaps(years, refresh=False):
    data.FILES.setdefault("snaps", SNAP_FILE)
    sn = pd.concat([pd.read_parquet(data._path("snaps", y, refresh)) for y in years], ignore_index=True)
    ro = pd.concat([data.rosters(y) for y in years], ignore_index=True)[["pfr_id", "gsis_id"]].dropna().drop_duplicates("pfr_id")
    sn = sn.merge(ro, left_on="pfr_player_id", right_on="pfr_id", how="left")
    return sn[["game_id", "gsis_id", "offense_pct"]].dropna()


def build(sp, cutoff, years, refresh=False):
    """Per player: last 5 games played (before cutoff) and TD rate over the last 8."""
    sp = sp[((sp.season * 100 + sp.week) < cutoff) & (sp.season_type == "REG")].copy()
    sp["o"] = sp.season * 100 + sp.week
    try:
        sn = _snaps(years, refresh)
        sp = sp.merge(sn, left_on=["game_id", "player_id"], right_on=["game_id", "gsis_id"], how="left")
    except Exception:
        sp["offense_pct"] = None
    sp = sp.sort_values("o")
    out = {}
    for pid, g in sp.groupby("player_id"):
        g8 = g.tail(8)
        g5 = g.tail(5)
        td = (g.rushing_tds.fillna(0) + g.receiving_tds.fillna(0))
        out[pid] = {
            "log": [{"wk": f"{int(r.season) % 100}-{int(r.week)}", "opp": r.opponent_team,
                     "ru": int(r.rushing_yards or 0), "re": int(r.receiving_yards or 0), "rc": int(r.receptions or 0),
                     "td": int((r.rushing_tds or 0) + (r.receiving_tds or 0)), "py": int(r.passing_yards or 0),
                     "sn": None if pd.isna(r.offense_pct) else round(float(r.offense_pct) * 100)} for r in g5.itertuples()],
            "tdHit": [int((td.loc[g8.index] >= 1).sum()), int(len(g8))],
        }
    return out
