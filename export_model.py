"""Export the model INPUTS for one week (team ratings, player usage, schedule) so the
Sim Lab page can run the simulations itself, in the browser, on demand.

    python3 export_model.py 2026 9 model_week.json
"""
import sys, os, json
from datetime import datetime
from zoneinfo import ZoneInfo
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from edge.engine import Engine
from edge import sim as S, ratings as RT, playerinfo as PI

SEASON = int(sys.argv[1]) if len(sys.argv) > 1 else 2026
WEEK = int(sys.argv[2]) if len(sys.argv) > 2 else 9
OUT = sys.argv[3] if len(sys.argv) > 3 else "model_week.json"

E = Engine(refresh_status="--no-refresh" not in sys.argv)   # fresh injury reports + rosters
cut = SEASON * 100 + WEEK
R, lg, U = E.prepare(SEASON, WEEK)
DVP = E.dvp(SEASON, WEEK)
INFO = PI.build(E.sp, cut, (SEASON - 1, SEASON), refresh="--no-refresh" not in sys.argv)
teams = pd.read_csv("https://github.com/nflverse/nflverse-data/releases/download/teams/teams_colors_logos.csv")
teams = teams.drop_duplicates("team_abbr").set_index("team_abbr")



def r4(x):
    return round(float(x), 5)


def lineup(t, game_week):
    """Players available for team t in that game week, with roles of anyone ruled out shared to teammates."""
    kept, info = E.availability(SEASON, WEEK, t, game_week)
    pl = kept.merge(E.names, on="player_id", how="left")
    qb = info["qb"]
    qbid = qb[0] if qb else None
    qset = {q["id"] for q in info["questionable"]}
    players = [{"id": r.player_id, "name": r["name"] if isinstance(r["name"], str) else r.player_id,
                "pos": "QB" if r.player_id == qbid else (r.position if isinstance(r.position, str) else "?"),
                "carry": r4(r.carry), "i10": r4(r.carry_i10), "rush": r4(r.rush_yds), "tgt": r4(r.target),
                "rz": r4(r.target_rz), "rec": r4(r.rec_yds), "cr": r4(r.catch_rate), "q": r.player_id in qset,
                "inh": float(r.inherited) if "inherited" in r and not pd.isna(r.inherited) else 0.0,
                **({"log": INFO[r.player_id]["log"], "tdHit": INFO[r.player_id]["tdHit"]} if r.player_id in INFO else {})}
               for _, r in pl.iterrows()]
    return {"players": players, "qb": {"id": qbid, "name": qb[1], "changed": bool(qb[2])} if qb else None,
            "injuries": {"week": int(game_week), "report": info["report"], "rosterWeek": info["rosterWeek"],
                         "out": [{"name": x["name"], "pos": x["pos"], "reason": x["reason"]} for x in info["removed"] if x["share"] >= 0.01 and not x["reason"].startswith("Backup QB")
                                 and x["reason"] != "No longer on the team"],   # gone players aren't shown, just left out
                         "questionable": [{"name": x["name"], "pos": x["pos"], "injury": x["injury"]} for x in info["questionable"]],
                         "returning": [{"name": x["name"], "pos": x["pos"]} for x in info["returning"]],
                         "watch": [{"name": x["name"], "pos": x["pos"], "note": x.get("note", "")} for x in info["watch"]]}}


out_teams = {}
for t in sorted(set(R.index.get_level_values(0))):
    if t not in teams.index:
        continue
    u = U[U.team == t]
    lu = lineup(t, WEEK)
    tr = teams.loc[t]
    out_teams[t] = {
        "name": tr.team_name, "c1": tr.team_color, "c2": tr.team_color2,
        "off": {k: r4(R.loc[(t, "off"), k]) for k in ("td", "fg", "pass_ypd", "rush_ypd", "drives")},
        "def": {k: r4(R.loc[(t, "def"), k]) for k in ("td", "fg", "pass_ypd", "rush_ypd", "drives")},
        "rtdFrac": r4(u.team_rush_td_frac.iloc[0]) if len(u) else 0.4,
        "tgtPg": r4(u.team_targets_pg.iloc[0]) if len(u) else 33.0,
        "qb": lu["qb"], "players": lu["players"], "injuries": lu["injuries"], "dvp": DVP.get(t),
    }


def uk_time(day, t):
    et = datetime.fromisoformat(f"{day}T{t}").replace(tzinfo=ZoneInfo("America/New_York"))
    return et.astimezone(ZoneInfo("Europe/London")).strftime("%a %d %b %H:%M")


sched = []
# any earlier game that hasn't been played yet (e.g. tonight's Monday Night Football) goes first
today = datetime.now(ZoneInfo("America/New_York")).strftime("%Y-%m-%d")
G = E.games
early = G[(G.season == SEASON) & (G.week < WEEK) & G.home_score.isna() & (G.gameday >= today)]
for _, r in pd.concat([early, E.week_games(SEASON, WEEK)]).iterrows():
    sched.append({"id": r.game_id, "home": r.home_team, "away": r.away_team, "kickoff": uk_time(r.gameday, r.gametime),
                  "neutral": bool(r.location == "Neutral"), "spread_home": float(r.spread_line), "total": float(r.total_line),
                  "week": int(r.week), "tonight": bool(r.gameday == today),
                  "restDiff": E.game_context(r.game_id)["rest_diff"], "roof": r.roof if isinstance(r.roof, str) else None,
                  "homeRest": None if pd.isna(r.home_rest) else int(r.home_rest), "awayRest": None if pd.isna(r.away_rest) else int(r.away_rest),
                  "odds": {k: (None if pd.isna(r[c]) else float(r[c])) for k, c in (("mlHome", "home_moneyline"), ("mlAway", "away_moneyline"),
                           ("spreadHome", "home_spread_odds"), ("spreadAway", "away_spread_odds"), ("over", "over_odds"), ("under", "under_odds"))},
                  "lineups": {t: lineup(t, int(r.week)) for t in (r.home_team, r.away_team)}})

out = {
    "season": SEASON, "week": WEEK, "dataThrough": f"{SEASON} week {WEEK - 1}",
    "injuryNote": "Players on reserve/IR, cut or traded, and anyone listed Out or Doubtful for that game week, are removed; their roles go to teammates. Questionable players stay in, flagged Q.",
    "generated": datetime.now(ZoneInfo("Europe/London")).strftime("%d %b %Y %H:%M"),
    "model": "Edge Engine v0.2.1",
    "lg": {k: r4(v) for k, v in lg.items()},
    "k": {"HFA": S.HFA, "PAT": S.PAT, "NONOFF": S.NONOFF_TD_PG, "YARD_NOISE": S.YARD_NOISE,
          "CONC": S.SHARE_CONC, "TD_FLATTEN": S.TD_FLATTEN, "TOUCHBACK": 35, "REST_K": S.REST_K,
          "WIND_PASS": S.WIND_PASS, "WIND_TD": S.WIND_TD, "WIND_FG": S.WIND_FG, "COLD_FG": S.COLD_FG, "OT_TD_BOOST": S.OT_TD_BOOST},
    "teams": out_teams, "games": sched,
}
json.dump(out, open(OUT, "w"), separators=(",", ":"))
print("teams", len(out_teams), "games", len(sched), "bytes", os.path.getsize(OUT))
