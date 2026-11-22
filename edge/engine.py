"""Convenience wrapper: load data once, build ratings for a week, simulate games."""
from __future__ import annotations
import numpy as np
import pandas as pd
from . import data, ratings, sim, markets, availability


class Engine:
    def __init__(self, years=(2024, 2025, 2026), refresh_status=False):
        self.games = data.games(refresh=refresh_status)
        y = max(years)
        self.injuries = data.injuries(y, refresh=refresh_status)     # small files: refresh before every live run
        self.rosters = data.rosters(y, refresh=refresh_status)
        self.pbp = data.pbp(years)
        self.tg = data.team_games(data.team_drives(self.pbp))
        sp = data.players(years)
        self.names = (sp.sort_values(["season", "week"]).drop_duplicates("player_id", keep="last")
                      [["player_id", "player_display_name", "position"]]
                      .rename(columns={"player_display_name": "name"}))
        self.sp = sp
        self._cache = {}
        self._dvp = {}

    def prepare(self, season, week):
        key = season * 100 + week
        if key not in self._cache:
            R, lg = ratings.team_ratings(self.tg, key)
            U = ratings.usage(self.pbp, key)
            self._cache[key] = (R, lg, U)
            self._dvp[key] = ratings.def_vs_pos(self.pbp, self.names, key)
        return self._cache[key]

    def dvp(self, season, week):
        self.prepare(season, week)
        return self._dvp[season * 100 + week]

    def game_context(self, game_id):
        """Rest difference, venue and (if known) weather for a scheduled game."""
        r = self.games[self.games.game_id == game_id].iloc[0]
        w = {"roof": r.roof, "wind": None if pd.isna(r.wind) else float(r.wind), "temp": None if pd.isna(r.temp) else float(r.temp)}
        return {"rest_diff": int((r.home_rest or 7) - (r.away_rest or 7)) if not (pd.isna(r.home_rest) or pd.isna(r.away_rest)) else 0,
                "neutral": r.location == "Neutral", "weather": w}

    def availability(self, season, week, team, game_week=None):
        """Adjusted usage + injury info for an upcoming game (see edge/availability.py).
        week = ratings cut-off week; game_week = the week of the game itself (its injury report)."""
        R, lg, U = self.prepare(season, week)
        st = availability.team_status(team, season, game_week or week, self.injuries, self.rosters)
        qb = availability.starting_qb(team, self.pbp, season * 100 + week, st["act"], st["out"], self.names)
        kept, info = availability.apply(U, self.names, team, season, game_week or week, self.injuries, self.rosters,
                                        starter=qb[0] if qb else None)
        info["qb"] = qb
        # Long-term returners: active, not ruled out, a real role for this team in the last 30 games, but little or no
        # role in the current (recent-weighted) usage. They get RETURN_ROLE of their role from their last 6 games played,
        # taken from teammates at the same position so team totals don't change.
        p = self.pbp[((self.pbp.season * 100 + self.pbp.week) < season * 100 + week) & (self.pbp.posteam == team)]
        p = p[(p.qb_kneel != 1) & (p.qb_spike != 1) & (p.two_point_attempt != 1)]
        gids = p.assign(o=p.season * 100 + p.week).drop_duplicates("game_id").sort_values("o").game_id.tail(30).tolist()
        p = p[p.game_id.isin(gids)]
        touches = pd.concat([p.rusher_player_id, p.receiver_player_id]).value_counts()
        info["watch"] = []
        kept = kept.copy()
        for pid, nt in touches.items():
            if nt < 40 or pid not in st["act"] or pid in st["out"]:
                continue
            nm = self.names.loc[self.names.player_id == pid]
            pos = nm.position.iloc[0] if len(nm) else "?"
            if pos == "QB":
                continue
            mine = p[(p.rusher_player_id == pid) | (p.receiver_player_id == pid)].game_id.unique()
            last6 = [g for g in gids if g in set(mine)][-6:]
            q = p[p.game_id.isin(last6)]
            ru = q[q.rush_attempt == 1]; pa = q[(q.pass_attempt == 1) & (q.sack == 0) & q.receiver_player_id.notna()]
            sh = lambda df, col, m=None: (lambda d: float((d[col] == pid).mean()) if len(d) else 0.0)(df if m is None else df[m(df)])
            ysh = lambda df, col: float(df[df[col] == pid].yards_gained.sum() / max(df.yards_gained.sum(), 1)) if len(df) else 0.0
            old = {"carry": sh(ru, "rusher_player_id"), "carry_i10": sh(ru, "rusher_player_id", lambda d: d.yardline_100 <= 10),
                   "rush_yds": ysh(ru, "rusher_player_id"), "target": sh(pa, "receiver_player_id"),
                   "target_rz": sh(pa, "receiver_player_id", lambda d: d.yardline_100 <= 20), "rec_yds": ysh(pa, "receiver_player_id")}
            cur = kept[kept.player_id == pid]
            cur_role = float(cur.carry.iloc[0] + cur.target.iloc[0]) if len(cur) else 0.0
            if cur_role >= 0.5 * (old["carry"] + old["target"]):
                continue                                     # already has (most of) his role
            grp = availability.GROUP.get(pos, "OTHER")
            mates = kept.merge(self.names[["player_id", "position"]], on="player_id", how="left")
            same = (mates.position.map(availability.GROUP).fillna("OTHER") == grp).values & (kept.player_id != pid).values
            if not len(cur):
                row = kept.iloc[[0]].copy(); row["player_id"] = pid; row["recent"] = False; row["catch_rate"] = 0.7
                for c in availability.SHARE_COLS: row[c] = 0.0
                kept = pd.concat([kept, row], ignore_index=True); same = np.append(same, False)
            idx = kept.index[kept.player_id == pid][0]
            for c in availability.SHARE_COLS:
                want = availability.RETURN_ROLE * old[c]
                add = max(0.0, want - kept.at[idx, c])
                pool = kept.loc[same, c].sum()
                if pool > 0 and add > 0:
                    take = min(add, 0.6 * pool)
                    kept.loc[same, c] = kept.loc[same, c] * (1 - take / pool)
                    kept.at[idx, c] += take
            info["returning"].append({"id": pid, "name": nm.name.iloc[0] if len(nm) else pid, "pos": pos})
            info["watch"].append({"id": pid, "name": nm.name.iloc[0] if len(nm) else pid, "pos": pos,
                                  "note": f"back from a long absence: given {int(availability.RETURN_ROLE * 100)}% of his old role"})
        return kept, info

    def simulate(self, season, week, home, away, n=10000, seed=0, available=None, neutral=False, anchor=None,
                 injuries=True, game_week=None, rest_diff=0, weather=None, use_dvp=True):
        """available=set of player ids (backtests: who actually played). Otherwise, with injuries=True,
        players ruled out / not active are removed and their roles shared out to teammates."""
        R, lg, U = self.prepare(season, week)
        self.last_availability = None
        if available is None and injuries:
            parts, info, avail = [U[~U.team.isin([home, away])]], {}, set()
            for t in (home, away):
                kept, info[t] = self.availability(season, week, t, game_week)
                parts.append(kept); avail |= set(kept.player_id)
            U = pd.concat(parts, ignore_index=True)
            available, self.last_availability = avail, info
        dvp = self.dvp(season, week) if use_dvp else None
        return sim.simulate(home, away, R, lg, U, self.names, n=n, seed=seed, available=available, neutral=neutral,
                            anchor=anchor, rest_diff=rest_diff, weather=weather, dvp=dvp)

    def week_games(self, season, week):
        return self.games[(self.games.season == season) & (self.games.week == week)]
