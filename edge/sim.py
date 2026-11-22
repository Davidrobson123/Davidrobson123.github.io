"""Monte Carlo game simulator.

Each simulated game: both teams get a number of drives; every drive ends in a TD, FG or
nothing, with probabilities from offence x defence ratings; yards follow from the drive
outcomes; then team yards, receptions and TDs are shared out to players by their usage.
Every market is later read off these simulated games, so correlations (QB yards and his
WR's TD, a team's points and its RB's yards) are kept automatically.
"""
from __future__ import annotations
from dataclasses import dataclass, field
import numpy as np
import pandas as pd

HFA = 1.038            # home TD/FG rate multiplier (away gets 1/HFA): ~1.7 pts, from 2015-26 lines with equal rest
REST_K = 0.0057        # per day of rest advantage (~0.25 pts/day, from 2,960 games' lines since 2015)
WIND_PASS, WIND_TD, WIND_FG = -0.013, -0.008, -0.011   # per mph above 10 (fitted on 2024-26 outdoor games)
COLD_FG = 0.90         # field-goal rate multiplier at 32F or colder
OT_TD_BOOST = 1.25     # 2nd OT possession needing a TD uses four downs
PAT = 0.95
NONOFF_TD_PG = 0.11    # defensive / special-teams TDs per team per game
YARD_NOISE = 0.18      # relative sd of team yards around drive-outcome expectation
SHARE_CONC = 18.0
TD_FLATTEN = 0.7      # <1 spreads TD shares toward depth players (calibration fix)      # Dirichlet concentration: lower = more week-to-week variance in player shares


@dataclass
class TeamSim:
    team: str
    pts: np.ndarray
    td: np.ndarray
    fg: np.ndarray
    pass_yds: np.ndarray
    rush_yds: np.ndarray
    players: pd.DataFrame = field(repr=False)          # player_id, name, position
    rush_yds_p: np.ndarray = field(repr=False, default=None)   # (n, k)
    rec_yds_p: np.ndarray = field(repr=False, default=None)
    rec_p: np.ndarray = field(repr=False, default=None)
    rush_td_p: np.ndarray = field(repr=False, default=None)
    rec_td_p: np.ndarray = field(repr=False, default=None)
    pass_td: np.ndarray = field(repr=False, default=None)


@dataclass
class GameSim:
    home: TeamSim
    away: TeamSim
    n: int

    @property
    def margin(self):          # home minus away
        return self.home.pts - self.away.pts

    @property
    def total(self):
        return self.home.pts + self.away.pts

    def player(self, name_or_id: str):
        for t in (self.home, self.away):
            pl = t.players
            m = (pl.player_id == name_or_id) | (pl.name.str.lower() == name_or_id.lower())
            if m.any():
                i = int(np.flatnonzero(m.values)[0])
                return {
                    "team": t.team, "name": pl.name.iat[i], "position": pl.position.iat[i],
                    "rush_yds": t.rush_yds_p[:, i], "rec_yds": t.rec_yds_p[:, i], "receptions": t.rec_p[:, i],
                    "rush_td": t.rush_td_p[:, i], "rec_td": t.rec_td_p[:, i],
                    "td": t.rush_td_p[:, i] + t.rec_td_p[:, i],
                }
        raise KeyError(name_or_id)


def _rate(R, lg, off, deff, k, mult=1.0):
    return lg[k] * (R.loc[(off, "off"), k] / lg[k]) * (R.loc[(deff, "def"), k] / lg[k]) * mult


def _dirichlet(rng, shares, n):
    a = np.maximum(shares * SHARE_CONC, 1e-3)
    g = rng.gamma(a, size=(n, len(a)))
    return g / g.sum(1, keepdims=True)


def _multinomial_rows(rng, counts, p):
    counts = counts.astype(np.int64)
    return rng.multinomial(counts, p)


def _team_players(U, team, available=None):
    u = U[U.team == team]
    if available is not None:
        u = u[u.player_id.isin(available)]
    else:
        u = u[u.recent]
    u = u[(u.carry + u.target + u.carry_i10 + u.target_rz) > 0.01].copy()
    return u


def weather_mult(weather):
    """(pass yards, TD rate, FG rate) multipliers. weather = {"roof": ..., "wind": mph, "temp": F}; indoors = none."""
    if not weather or weather.get("roof") in ("dome", "closed"):
        return 1.0, 1.0, 1.0
    w = max(0.0, min(float(weather.get("wind") or 0), 25.0) - 10)
    cold = weather.get("temp") is not None and float(weather["temp"]) <= 32
    return 1 + WIND_PASS * w, 1 + WIND_TD * w, (1 + WIND_FG * w) * (COLD_FG if cold else 1.0)


def possessions(rng, pace, n):
    """Coin toss + halves: drives alternate within each half, the team receiving a half gets the odd drive.
    Returns (home drives, away drives, home received the opening kick)."""
    tot = np.clip(np.rint(rng.normal(2 * pace, 1.3, n)), 16, 30).astype(int)
    h1 = np.clip(np.rint(tot / 2 + rng.normal(0, 0.8, n)), 7, 16).astype(int)
    h2 = tot - h1
    home_first = rng.random(n) < 0.5            # toss: whoever receives the opening kick, the other receives in half 2
    r1 = (h1 + 1) // 2 + h2 // 2                # opening receiver's drives
    r2 = h1 // 2 + (h2 + 1) // 2
    return np.where(home_first, r1, r2), np.where(home_first, r2, r1), home_first


def overtime(rng, n_idx, ph, pa, first_home):
    """2025+ regular-season OT: toss winner receives; both teams get a possession; then sudden death; 10 min so
    at most 4 more possessions, else a tie. Returns (home pts, away pts, home tds, away tds, home fgs, away fgs)."""
    hp = np.zeros(n_idx, int); ap = np.zeros(n_idx, int); ht = np.zeros(n_idx, int); at = np.zeros(n_idx, int)
    hf = np.zeros(n_idx, int); af = np.zeros(n_idx, int)
    def drive(p, need_td=False):
        x = rng.random()
        if need_td:
            return "TD" if x < min(p[0] * OT_TD_BOOST, 0.7) else "none"
        return "TD" if x < p[0] else "FG" if x < p[0] + p[1] else "none"
    for i in range(n_idx):
        order = ["h", "a"] if first_home[i] else ["a", "h"]
        P = {"h": ph, "a": pa}; pts = {"h": 0, "a": 0}; tds = {"h": 0, "a": 0}; fgs = {"h": 0, "a": 0}
        r1 = drive(P[order[0]])
        r2 = drive(P[order[1]], need_td=(r1 == "TD"))
        for t, r in ((order[0], r1), (order[1], r2)):
            if r == "TD": pts[t] += 7; tds[t] += 1
            elif r == "FG": pts[t] += 3; fgs[t] += 1
        k = 0
        while pts["h"] == pts["a"] and k < 4:          # sudden death (10-minute period)
            t = order[k % 2]; r = drive(P[t])
            if r == "TD": pts[t] += 6; tds[t] += 1
            elif r == "FG": pts[t] += 3; fgs[t] += 1
            k += 1
        hp[i], ap[i], ht[i], at[i], hf[i], af[i] = pts["h"], pts["a"], tds["h"], tds["a"], fgs["h"], fgs["a"]
    return hp, ap, ht, at, hf, af


def simulate(home, away, R, lg, U, names, n=10000, seed=0, available=None, neutral=False, anchor=None,
             rest_diff=0, weather=None, dvp=None):
    """anchor=(home_spread_line, total_line): scale scoring so the sim matches the market's
    expected points, keeping the model's player distribution (market-anchored mode).
    rest_diff = home rest days - away rest days. weather = {"roof","wind","temp"} (forecast; indoors ignored).
    dvp = defence-vs-position factors from ratings.def_vs_pos (who a defence leaks yards and TDs to)."""
    rng = np.random.default_rng(seed)
    hfa = 1.0 if neutral else HFA * (1 + REST_K * float(np.clip(rest_diff, -7, 7)))
    wp, wt, wf = weather_mult(weather)
    pace = (R.loc[(home, "off"), "drives"] + R.loc[(away, "off"), "drives"] +
            R.loc[(home, "def"), "drives"] + R.loc[(away, "def"), "drives"]) / 4
    d_home, d_away, home_first = possessions(rng, pace, n)
    sims, P = {}, {}
    for team, opp, D, mult in ((home, away, d_home, hfa), (away, home, d_away, 1 / hfa)):
        ptd = _rate(R, lg, team, opp, "td", mult) * wt
        pfg = _rate(R, lg, team, opp, "fg", mult) * wf
        if anchor is not None:
            spread_home, tot = anchor                     # spread_home: expected home margin (nflverse spread_line)
            target = (tot + spread_home) / 2 if team == home else (tot - spread_home) / 2
            exp_pts = D.mean() * (ptd * (6 + PAT) + pfg * 3) + 7 * NONOFF_TD_PG
            k = max(target - 7 * NONOFF_TD_PG, 1) / max(exp_pts - 7 * NONOFF_TD_PG, 1)
            ptd, pfg = ptd * k, pfg * k
        ptd, pfg = min(ptd, 0.6), min(pfg, 0.35)
        P[team] = (ptd, pfg)
        out = rng.multinomial(D.astype(np.int64), [ptd, pfg, 1 - ptd - pfg])
        td, fg = out[:, 0], out[:, 1]
        pat = rng.binomial(td, PAT)
        nonoff = rng.poisson(NONOFF_TD_PG, n)
        pts = 6 * td + pat + 3 * fg + 7 * nonoff
        sims[team] = dict(pts=pts, td=td, fg=fg, D=D, ptd=ptd, pfg=pfg, nonoff=nonoff)
    # overtime for games level after regulation
    tie = np.flatnonzero(sims[home]["pts"] == sims[away]["pts"])
    ot = np.zeros(n, bool); ot[tie] = True
    if len(tie):
        first_home = rng.random(len(tie)) < 0.5
        hp, ap, ht, at, hf, af = overtime(rng, len(tie), P[home], P[away], first_home)
        for t, pp, tt, ff in ((home, hp, ht, hf), (away, ap, at, af)):
            sims[t]["pts"][tie] += pp; sims[t]["td"][tie] += tt; sims[t]["fg"][tie] += ff
    for team, opp in ((home, away), (away, home)):
        s = sims[team]; D, td, fg, ptd, pfg = s["D"], s["td"], s["fg"], s["ptd"], s["pfg"]
        # yards: expected yards per drive scale with drive success; noise multiplicative
        e_pass = _rate(R, lg, team, opp, "pass_ypd") * D * wp
        e_rush = _rate(R, lg, team, opp, "rush_ypd") * D
        succ = (td + 0.6 * fg) - (ptd + 0.6 * pfg) * D          # over/under-performance in drives
        f = np.clip(1 + 0.11 * succ + rng.normal(0, YARD_NOISE, n), 0.3, 2.2)
        pass_yds = e_pass * f
        rush_yds = e_rush * f
        s.update(pass_yds=pass_yds, rush_yds=rush_yds)
    # game script: trailing team throws more, leading team runs more
    for team, opp in ((home, away), (away, home)):
        s, o = sims[team], sims[opp]
        lead = (s["pts"] - o["pts"]) / 7.0
        tot = s["pass_yds"] + s["rush_yds"]
        shift = np.clip(0.025 * lead, -0.12, 0.12)
        ps = s["pass_yds"] / np.maximum(tot, 1) - shift
        s["pass_yds"], s["rush_yds"] = tot * ps, tot * (1 - ps)

    teams = {}
    for team, opp in ((home, away), (away, home)):
        s = sims[team]
        u = _team_players(U, team, available).copy()
        pl = u[["player_id"]].merge(names, on="player_id", how="left")
        pl["name"] = pl["name"].fillna(pl.player_id)
        pl["position"] = pl["position"].fillna("?")
        k = len(u)
        if dvp is not None and opp in dvp and k:      # matchup: who this defence gives yards and TDs to
            u = apply_dvp(u, pl.position.values, dvp[opp])
        # "other" bucket absorbs usage of players not modelled
        def with_other(col):
            v = u[col].values
            return np.append(v, max(1e-3, 1 - v.sum()))
        rush_sh = _dirichlet(rng, with_other("rush_yds").clip(1e-3), n)[:, :k]
        rec_sh = _dirichlet(rng, with_other("rec_yds").clip(1e-3), n)[:, :k]
        rush_yds_p = rush_sh * s["rush_yds"][:, None]
        rec_yds_p = rec_sh * s["pass_yds"][:, None]
        tgt_lam = u.target.values * u.team_targets_pg.values * u.catch_rate.values
        rec_p = rng.poisson(tgt_lam[None, :] * (s["pass_yds"] / np.mean(s["pass_yds"]))[:, None])
        frac = float(u.team_rush_td_frac.iloc[0]) if k else 0.4
        rtd = rng.binomial(s["td"], frac)
        ptd_n = s["td"] - rtd
        rtd_share = (0.55 * u.carry_i10.values + 0.45 * u.carry.values) ** TD_FLATTEN
        ptd_share = (0.5 * u.target_rz.values + 0.5 * u.target.values) ** TD_FLATTEN
        rtd_share = rtd_share / max(rtd_share.sum(), 1e-9) * min(0.97, (0.55 * u.carry_i10 + 0.45 * u.carry).sum())
        ptd_share = ptd_share / max(ptd_share.sum(), 1e-9) * min(0.97, (0.5 * u.target_rz + 0.5 * u.target).sum())
        def alloc(cnt, sh):
            p = np.append(sh, max(1e-3, 1 - sh.sum()))
            p = p / p.sum()
            return _multinomial_rows(rng, cnt, p)[:, :k]
        teams[team] = TeamSim(team, s["pts"], s["td"], s["fg"], s["pass_yds"], s["rush_yds"], pl,
                              rush_yds_p, rec_yds_p, rec_p, alloc(rtd, rtd_share), alloc(ptd_n, ptd_share), ptd_n)
    g = GameSim(teams[home], teams[away], n)
    g.overtime, g.home_first = ot, home_first
    return g


GROUP = {"RB": "RB", "FB": "RB", "HB": "RB", "WR": "WR", "TE": "TE", "QB": "QB"}


def apply_dvp(u, positions, f):
    """Tilt a team's shares toward the positions this defence leaks to, keeping the team totals the same."""
    u = u.copy()
    grp = np.array([GROUP.get(p, "OTHER") for p in positions])
    def tilt(cols, table):
        m = np.array([table.get(g, 1.0) for g in grp])
        for c in cols:
            v = u[c].values; tot = v.sum()
            if tot > 0:
                nv = v * m; u[c] = nv * tot / nv.sum()
    tilt(["rec_yds", "target"], f["rec"])
    tilt(["target_rz"], f["ptd"])
    tilt(["carry_i10"], f["rtd"])
    return u
