"""Team strength and player usage, computed only from games played before a cut-off.

Ratings are drive-based: how often a team's drives end in a TD or FG, and how many yards
it gains per drive, on offence and allowed on defence. Recent games weigh more
(exponential decay), and every team is pulled toward league average by a prior.
"""
from __future__ import annotations
import numpy as np
import pandas as pd

HALF_LIFE_GAMES = 12     # weight halves every N games back
PRIOR_GAMES = 8          # pseudo-games of league-average added to each team
USAGE_HALF_LIFE = 4      # player roles change faster than team strength


def _decay_weights(seq: pd.Series, half_life: float) -> np.ndarray:
    age = seq.max() - seq
    return 0.5 ** (age / half_life)


def team_ratings(tg: pd.DataFrame, cutoff: int) -> tuple[pd.DataFrame, dict]:
    """tg = data.team_games(); cutoff = season*100+week of the target week (exclusive)."""
    d = tg[tg.order < cutoff].copy()
    d["ypd"] = (d.pass_yds + d.rush_yds) / d.drives
    lg = {
        "td": d.td.sum() / d.drives.sum(), "fg": d.fg.sum() / d.drives.sum(),
        "drives": d.drives.mean(),
        "pass_ypd": d.pass_yds.sum() / d.drives.sum(), "rush_ypd": d.rush_yds.sum() / d.drives.sum(),
    }
    rows = []
    for side, team_col in (("off", "posteam"), ("def", "defteam")):
        for team, g in d.groupby(team_col):
            g = g.sort_values("order").tail(40)
            seq = pd.Series(np.arange(len(g)), index=g.index)
            w = _decay_weights(seq, HALF_LIFE_GAMES) * g.drives.values
            W = w.sum() + PRIOR_GAMES * lg["drives"]
            r = {"team": team, "side": side}
            for k, col in (("td", "td"), ("fg", "fg")):
                rate = (w * g[col] / g.drives).sum()
                r[k] = (rate + PRIOR_GAMES * lg["drives"] * lg[k]) / W
            for k, col in (("pass_ypd", "pass_yds"), ("rush_ypd", "rush_yds")):
                rate = (w * g[col] / g.drives).sum()
                r[k] = (rate + PRIOR_GAMES * lg["drives"] * lg[k]) / W
            r["drives"] = np.average(g.drives, weights=w)
            rows.append(r)
    R = pd.DataFrame(rows).set_index(["team", "side"])
    return R, lg


def usage(p: pd.DataFrame, cutoff: int, team_last_games: int = 10) -> pd.DataFrame:
    """Per player per team: weighted shares of carries, targets, red-zone work and yards.

    Uses each team's last `team_last_games` games before cutoff, decayed by USAGE_HALF_LIFE.
    """
    p = p[(p.season * 100 + p.week) < cutoff]
    p = p[p.posteam.notna() & (p.qb_kneel != 1) & (p.qb_spike != 1) & (p.two_point_attempt != 1)]
    out = []
    for team, t in p.groupby("posteam"):
        gids = t.drop_duplicates("game_id").assign(o=lambda x: x.season * 100 + x.week).sort_values("o")
        gids = gids.game_id.tail(team_last_games).tolist()
        t = t[t.game_id.isin(gids)]
        age = {g: len(gids) - 1 - i for i, g in enumerate(gids)}
        t = t.assign(w=t.game_id.map(age).map(lambda a: 0.5 ** (a / USAGE_HALF_LIFE)))
        ru = t[t.rush_attempt == 1]
        pa = t[(t.pass_attempt == 1) & (t.sack == 0) & t.receiver_player_id.notna()]
        feats = {}
        def share(df, idcol, val=None, mask=None, name=""):
            df = df if mask is None else df[mask(df)]
            v = df.w if val is None else df.w * df[val].fillna(0)
            s = v.groupby(df[idcol]).sum()
            feats[name] = s / s.sum() if s.sum() > 0 else s
        share(ru, "rusher_player_id", name="carry")
        share(ru, "rusher_player_id", mask=lambda d: d.yardline_100 <= 10, name="carry_i10")
        share(ru, "rusher_player_id", val="yards_gained", name="rush_yds")
        share(pa, "receiver_player_id", name="target")
        share(pa, "receiver_player_id", mask=lambda d: d.yardline_100 <= 20, name="target_rz")
        share(pa, "receiver_player_id", val="yards_gained", name="rec_yds")
        catches = pa[pa.yards_gained.notna()]
        df = pd.DataFrame(feats).fillna(0)
        # catch rate (complete_pass not in cols; approximate: receptions = targets with yards!=0 or TD)
        comp = pa.assign(c=((pa.yards_gained != 0) | (pa.pass_touchdown == 1)).astype(float))
        cr = (comp.w * comp.c).groupby(comp.receiver_player_id).sum() / comp.w.groupby(comp.receiver_player_id).sum()
        df["catch_rate"] = cr.reindex(df.index).fillna(0.65).clip(0.3, 0.95)
        # team-level splits used to split TDs between rushing and passing
        rtd = (t.w * t.rush_touchdown.fillna(0)).sum()
        ptd = (t.w * t.pass_touchdown.fillna(0)).sum()
        df["team"] = team
        df["team_rush_td_frac"] = (rtd + 3) / (rtd + ptd + 7.5)   # shrunk toward ~40%
        df["team_targets_pg"] = len(pa) / max(len(gids), 1)
        last2 = gids[-2:]
        played_recent = set(t[t.game_id.isin(last2)].rusher_player_id.dropna()) | set(
            t[t.game_id.isin(last2)].receiver_player_id.dropna())
        df["recent"] = df.index.isin(played_recent)
        out.append(df)
    U = pd.concat(out).rename_axis("player_id").reset_index()
    return U


DVP_PRIOR = 6.0     # pseudo-games of league-average pattern added to every defence
DVP_HALF_LIFE = 8


def def_vs_pos(p, names, cutoff, last_games=16):
    """Defence vs position: for each defence, how its receiving yards, receiving TDs and rushing TDs allowed split
    across positions, relative to league average (1.0 = average; 1.2 = leaks 20% more to that position).
    Only games before `cutoff` are used."""
    pos = names.set_index("player_id").position.map({"RB": "RB", "FB": "RB", "HB": "RB", "WR": "WR", "TE": "TE", "QB": "QB"})
    p = p[((p.season * 100 + p.week) < cutoff) & p.defteam.notna()].copy()
    p["o"] = p.season * 100 + p.week
    rec = p[(p.pass_attempt == 1) & (p.sack == 0) & p.receiver_player_id.notna()].copy()
    rec["grp"] = rec.receiver_player_id.map(pos)
    rec["yds"] = rec.yards_gained.fillna(0)
    rec["td"] = rec.pass_touchdown.fillna(0)
    ru = p[(p.rush_attempt == 1) & (p.rush_touchdown == 1) & p.rusher_player_id.notna()].copy()
    ru["grp"] = ru.rusher_player_id.map(pos)

    def shares(df, val):
        s = df.groupby("grp")[val].sum() if val else df.groupby("grp").size()
        return s / s.sum() if s.sum() else s

    lg = {"rec": shares(rec, "yds"), "ptd": shares(rec, "td"), "rtd": shares(ru, None)}
    out = {}
    for d in p.defteam.unique():
        games = p[p.defteam == d].drop_duplicates("game_id").sort_values("o").game_id.tail(last_games).tolist()
        age = {g: len(games) - 1 - i for i, g in enumerate(games)}
        wf = lambda df: df.game_id.map(age).map(lambda a: 0.5 ** (a / DVP_HALF_LIFE))
        r = rec[rec.game_id.isin(games) & (rec.defteam == d)].copy(); r["w"] = wf(r)
        q = ru[ru.game_id.isin(games) & (ru.defteam == d)].copy(); q["w"] = wf(q)
        ng = sum(0.5 ** (a / DVP_HALF_LIFE) for a in age.values())
        f = {}
        for key, df, val, per_game, prior in (("rec", r, "yds", 230.0, DVP_PRIOR), ("ptd", r, "td", 1.4, 16.0), ("rtd", q, None, 0.9, 12.0)):
            v = (df.w * (df[val] if val else 1)).groupby(df.grp).sum()
            tot = v.sum()
            f[key] = {}
            for gname in ("RB", "WR", "TE", "QB"):
                base = float(lg[key].get(gname, 0))
                if base < 0.05:                       # positions that rarely get these (QB catches, WR rush TDs)
                    f[key][gname] = 1.0
                    continue
                share = (float(v.get(gname, 0)) + prior * per_game * base) / (float(tot) + prior * per_game)
                f[key][gname] = round(float(min(max(share / base, 0.7), 1.4)), 4)
        out[d] = f
    return out
