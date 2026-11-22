"""Drive-by-drive replay of ONE simulated game, for watching a simulation play out.

Uses the same drive rates and player shares as sim.simulate (so a replay is a typical draw
from the same model), but keeps the order of drives, field position, plays and scorers.
"""
from __future__ import annotations
import numpy as np
from . import sim as S

KICK_TOUCHBACK = 35   # 2025+ kickoff rules: touchback to the 35


def _shares(u):
    r = (0.55 * u.carry_i10.values + 0.45 * u.carry.values) ** S.TD_FLATTEN
    p = (0.5 * u.target_rz.values + 0.5 * u.target.values) ** S.TD_FLATTEN
    r = np.append(r, max(1e-3, 1 - r.sum())); p = np.append(p, max(1e-3, 1 - p.sum()))
    return r / r.sum(), p / p.sum()


def replay(home, away, R, lg, U, names, qbs, seed=0, anchor=None, neutral=False):
    rng = np.random.default_rng(seed)
    hfa = 1.0 if neutral else S.HFA
    pace = (R.loc[(home, "off"), "drives"] + R.loc[(away, "off"), "drives"] +
            R.loc[(home, "def"), "drives"] + R.loc[(away, "def"), "drives"]) / 4
    rates, people = {}, {}
    for team, opp, mult in ((home, away, hfa), (away, home, 1 / hfa)):
        ptd = S._rate(R, lg, team, opp, "td", mult)
        pfg = S._rate(R, lg, team, opp, "fg", mult)
        if anchor is not None:
            spread_home, tot = anchor
            target = (tot + spread_home) / 2 if team == home else (tot - spread_home) / 2
            exp_pts = pace * (ptd * (6 + S.PAT) + pfg * 3) + 7 * S.NONOFF_TD_PG
            k = max(target - 7 * S.NONOFF_TD_PG, 1) / max(exp_pts - 7 * S.NONOFF_TD_PG, 1)
            ptd, pfg = ptd * k, pfg * k
        rates[team] = (min(ptd, 0.6), min(pfg, 0.35))
        u = S._team_players(U, team)
        pl = u[["player_id"]].merge(names, on="player_id", how="left")
        rs, ps = _shares(u)
        people[team] = (pl["name"].fillna("Unknown").tolist() + ["another player"], rs, ps,
                        float(u.team_rush_td_frac.iloc[0]) if len(u) else 0.4, qbs.get(team, "the QB"))
    n_drives = int(np.clip(np.rint(rng.normal(pace, 0.9)), 9, 14)) * 2
    order = [away, home] if rng.random() < 0.5 else [home, away]
    score = {home: 0, away: 0}
    start = KICK_TOUCHBACK
    drives = []
    for i in range(n_drives):
        team = order[i % 2]
        opp = order[(i + 1) % 2]
        q = min(4, 1 + i * 4 // n_drives)
        ptd, pfg = rates[team]
        x = rng.random()
        if x < ptd:
            res = "TD"
        elif x < ptd + pfg:
            res = "FG"
        else:
            res = rng.choice(["Punt", "Punt", "Punt", "Turnover", "Downs"], p=[.22, .22, .22, .22, .12])
        if res == "TD":
            end = 100
        elif res == "FG":
            end = int(np.clip(rng.normal(72, 8), 55, 90))
        else:
            end = int(np.clip(start + rng.gamma(2.0, 12), start, 85))
        end = max(end, start)
        yards = end - start
        plays = int(max(3 if res != "Turnover" else 1, round(yards / 5.6 + rng.normal(1, 1.5))))
        text, scorer = "", None
        names_t, rs, ps, rfrac, qb = people[team]
        if res == "TD":
            if rng.random() < rfrac:
                scorer = names_t[rng.choice(len(rs), p=rs)]
                text = f"{scorer} rushing TD"
            else:
                scorer = names_t[rng.choice(len(ps), p=ps)]
                text = f"{scorer} TD catch from {qb}"
            score[team] += 6 + int(rng.random() < S.PAT)
        elif res == "FG":
            dist = 100 - end + 17
            if rng.random() < (0.97 if dist < 40 else 0.88 if dist < 50 else 0.7):
                score[team] += 3; text = f"{dist}-yard field goal good"
            else:
                res = "Missed FG"; text = f"{dist}-yard field goal missed"
        elif res == "Punt":
            text = "Punt"
        elif res == "Turnover":
            text = rng.choice(["Interception", "Fumble lost"])
        else:
            text = "Turnover on downs"
        drives.append({"i": i, "q": q, "team": team, "start": int(start), "end": int(end), "yards": int(yards),
                       "plays": plays, "result": res, "text": text, "scorer": scorer,
                       "home": score[home], "away": score[away]})
        # next drive's start (from the receiving team's own goal line)
        if res in ("TD", "FG"):
            start = KICK_TOUCHBACK
        elif res == "Punt":
            start = int(np.clip(100 - end - rng.normal(42, 8), 5, 40))
        else:
            start = int(np.clip(100 - end, 5, 80))
        if i == n_drives // 2 - 1:            # second-half kickoff
            start = KICK_TOUCHBACK
    return {"home": home, "away": away, "drives": drives, "final": {home: score[home], away: score[away]}}
