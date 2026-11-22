"""Who is actually available for a game, so we never simulate with players who won't play.

Rules (applied to every simulation of an upcoming game):
- Player must be on the team's latest weekly roster with status ACT (drops IR/reserve, cut, traded, practice squad).
- Player must not be listed Out or Doubtful on that game week's injury report.
- Questionable players stay in and are flagged.
- An unavailable player's carries, targets, red-zone work and yards are shared out to teammates at the same
  position, in proportion to their existing roles (to everyone if no teammate at that position remains).
- Players back from injury (on the roster, not on the report, but missing from recent games) are kept.
- Starting QB = last game's passer if available, otherwise the available QB with the most recent dropbacks.
"""
from __future__ import annotations
import pandas as pd

SHARE_COLS = ["carry", "carry_i10", "rush_yds", "target", "target_rz", "rec_yds"]
GROUP = {"RB": "RB", "FB": "RB", "HB": "RB", "WR": "WR", "TE": "TE", "QB": "QB"}
RETURN_ROLE = 0.6   # share of a long-term returner's old role in his first games back (assumption; check in the ledger)


def team_status(team, season, week, inj, rost):
    rw = rost[(rost.season == season) & (rost.week <= week)]
    rw = rw[rw.week == rw.week.max()] if len(rw) else rw
    tr = rw[rw.team == team]
    act = set(tr[tr.status == "ACT"].gsis_id)
    ir = inj[(inj.season == season) & (inj.week == week) & (inj.team == team)]
    # Late news the injury feed hasn't caught yet (game-day inactives, players ruled out after the report):
    # EDGE_FORCE_OUT="Name One;Name Two" removes them and re-shares their role, exactly like an Out listing.
    import os
    forced = {x.strip() for x in os.environ.get("EDGE_FORCE_OUT", "").split(";") if x.strip()}
    namecol = next((c for c in ("full_name", "player_name", "name") if c in tr.columns), None)
    forced_ids = set(tr[tr[namecol].isin(forced)].gsis_id) if forced and namecol else set()
    out = {r.gsis_id: (r.report_status, r.report_primary_injury) for r in ir.itertuples() if r.report_status in ("Out", "Doubtful")}
    for pid in forced_ids:
        out[pid] = ("Out", "ruled out on game day")
    return {
        "roster_week": int(rw.week.max()) if len(rw) else None,
        "act": act, "on_roster": set(tr.gsis_id),
        "report": len(ir) > 0,
        "out": out,
        "q": {r.gsis_id: r.report_primary_injury for r in ir.itertuples() if r.report_status == "Questionable"},
    }


def apply(U, names, team, season, week, inj, rost, starter=None):
    """Return (adjusted usage rows for `team`, info dict). starter = starting QB id (other QBs sit)."""
    st = team_status(team, season, week, inj, rost)
    u = U[U.team == team].copy()
    u = u[(u.carry + u.target + u.carry_i10 + u.target_rz) > 0.01]
    u = u.merge(names[["player_id", "name", "position"]], on="player_id", how="left")
    u["grp"] = u.position.map(GROUP).fillna("OTHER")
    if st["act"]:
        ok_roster = u.player_id.isin(st["act"])
    else:                                   # no roster file for this team: fall back to "played recently"
        ok_roster = u.recent
    ok = ok_roster & ~u.player_id.isin(st["out"].keys())
    backup_qb = (u.grp == "QB") & (u.player_id != starter) if starter else pd.Series(False, index=u.index)
    ok = ok & ~backup_qb
    kept, gone = u[ok].copy(), u[~ok]
    base_role = (kept.carry + kept.target + kept.carry_i10 + kept.target_rz).copy()
    for col in SHARE_COLS:
        for _, g in gone.iterrows():
            v = g[col]
            if v <= 0:
                continue
            pool = kept[kept.grp == g.grp]
            if pool[col].sum() <= 0:
                pool = kept
            tot = pool[col].sum()
            if tot > 0:
                kept.loc[pool.index, col] += v * pool[col] / tot
    new_role = kept.carry + kept.target + kept.carry_i10 + kept.target_rz
    kept["inherited"] = ((new_role - base_role) / new_role.where(new_role > 0, 1)).clip(lower=0).round(3)
    removed = []
    for _, g in gone.iterrows():
        if g.player_id in st["out"]:
            s, why = st["out"][g.player_id]; reason = f"{s} ({why})" if isinstance(why, str) else s
        elif starter and g.grp == "QB" and g.player_id != starter and g.player_id in st["act"]:
            reason = "Backup QB (not starting)"
        elif g.player_id in st["on_roster"]:
            reason = "Not active (reserve/IR or practice squad)"
        else:
            reason = "No longer on the team"
        removed.append({"id": g.player_id, "name": g["name"], "pos": g.position, "reason": reason,
                        "share": round(float(0.5 * g.carry + 0.5 * g.target), 3)})
    info = {
        "report": st["report"], "rosterWeek": st["roster_week"],
        "removed": sorted(removed, key=lambda r: -r["share"]),
        "questionable": [{"id": r.player_id, "name": r["name"], "pos": r.position, "injury": st["q"][r.player_id]}
                         for _, r in kept.iterrows() if r.player_id in st["q"]],
        "returning": [{"id": r.player_id, "name": r["name"], "pos": r.position} for _, r in kept.iterrows()
                      if not r.recent and (0.5 * r.carry + 0.5 * r.target) >= 0.01],
    }
    return kept.drop(columns=["name", "position", "grp"]), info


def starting_qb(team, pbp, cut, act, out, names):
    p = pbp[((pbp.season * 100 + pbp.week) < cut) & (pbp.posteam == team) & pbp.passer_player_id.notna()]
    if not len(p):
        return None
    p = p.assign(o=p.season * 100 + p.week)
    last = p[p.o == p.o.max()].passer_player_id.value_counts()
    recent = p[p.o >= sorted(p.o.unique())[-min(4, p.o.nunique())]].passer_player_id.value_counts()
    ok = lambda pid: (not act or pid in act) and pid not in out
    for pid in list(last.index) + list(recent.index):
        if ok(pid):
            nm = names.loc[names.player_id == pid, "name"]
            return pid, (nm.iloc[0] if len(nm) else pid), pid != last.index[0]
    # Nobody who threw for this team recently is available (starter and backup both out): take the active
    # player with the most career passes in the data, e.g. a veteran backup signed from another team.
    allp = pbp[((pbp.season * 100 + pbp.week) < cut) & pbp.passer_player_id.notna()].passer_player_id.value_counts()
    for pid in allp.index:
        if act and pid in act and pid not in out:
            nm = names.loc[names.player_id == pid, "name"]
            return pid, (nm.iloc[0] if len(nm) else pid), True
    return None
