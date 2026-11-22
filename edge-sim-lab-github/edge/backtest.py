"""Walk-forward backtest: for each week, rate teams using only earlier games, simulate,
and score the predictions against results AND against the closing market lines."""
from __future__ import annotations
import numpy as np
import pandas as pd
from . import markets as M


def run(E, weeks, n=4000, anchor=False, use_dvp=True, use_context=True):
    games_out, players_out = [], []
    sp = E.sp
    for season, week in weeks:
        wk = E.week_games(season, week).dropna(subset=["home_score"])
        for _, r in wk.iterrows():
            played = sp[sp.game_id == r.game_id]
            avail = set(played.player_id)
            ctx = E.game_context(r.game_id) if use_context else {"rest_diff": 0, "weather": None}
            g = E.simulate(season, week, r.home_team, r.away_team, n=n, seed=week,
                           available=avail, neutral=(r.location == "Neutral"),
                           anchor=(r.spread_line, r.total_line) if anchor else None,
                           rest_diff=ctx["rest_diff"], weather=ctx["weather"], use_dvp=use_dvp)
            s = M.summary(g)
            hd, ad = M.dec_from_american(r.home_moneyline), M.dec_from_american(r.away_moneyline)
            mkt_home = M.devig([hd, ad])[0]
            games_out.append({
                "season": season, "week": week, "game_id": r.game_id,
                "model_margin": s["mean_margin"], "mkt_margin": r.spread_line, "act_margin": r.home_score - r.away_score,
                "model_total": float(g.total.mean()), "mkt_total": r.total_line, "act_total": r.home_score + r.away_score,
                "model_home": s["home_win"], "mkt_home": mkt_home,
                "home_won": float(r.home_score > r.away_score) + 0.5 * float(r.home_score == r.away_score),
                "rest_diff": ctx["rest_diff"], "sim_ot": float(g.overtime.mean()), "sim_tie": float((g.margin == 0).mean()),
                "act_ot": float(r.overtime == 1) if "overtime" in r else float("nan"),
            })
            pt = M.player_table(g, top=None)
            act = played.assign(td=played.rushing_tds.fillna(0) + played.receiving_tds.fillna(0))
            act = act.set_index("player_display_name")["td"]
            for _, p in pt.iterrows():
                players_out.append({"season": season, "week": week, "game_id": r.game_id, "player": p.player,
                                    "pos": p.pos, "p_td": p.anytime_td,
                                    "scored": float(act.get(p.player, 0) >= 1)})
    return pd.DataFrame(games_out), pd.DataFrame(players_out)


def report(G, P):
    out = {}
    out["games"] = len(G)
    out["margin_mae_model"] = (G.model_margin - G.act_margin).abs().mean()
    out["margin_mae_market"] = (G.mkt_margin - G.act_margin).abs().mean()
    out["total_mae_model"] = (G.model_total - G.act_total).abs().mean()
    out["total_mae_market"] = (G.mkt_total - G.act_total).abs().mean()
    ll = lambda p, y: -np.mean(y * np.log(np.clip(p, 1e-6, 1)) + (1 - y) * np.log(np.clip(1 - p, 1e-6, 1)))
    y = (G.home_won > 0.5).astype(float)
    out["winprob_logloss_model"] = ll(G.model_home, y)
    out["winprob_logloss_market"] = ll(G.mkt_home, y)
    blend = 0.25 * G.model_home + 0.75 * G.mkt_home
    out["winprob_logloss_blend_25"] = ll(blend, y)
    # does the model know something the market doesn't? regress (actual - market) on (model - market)
    dm = G.model_margin - G.mkt_margin
    out["margin_info_corr"] = np.corrcoef(dm, G.act_margin - G.mkt_margin)[0, 1]
    dt = G.model_total - G.mkt_total
    out["total_info_corr"] = np.corrcoef(dt, G.act_total - G.mkt_total)[0, 1]
    # simple ATS / O-U: bet when model disagrees by 3+ pts (no juice adjustment)
    big = dm.abs() >= 3
    cover = np.sign(dm[big]) == np.sign((G.act_margin - G.mkt_margin)[big])
    push = (G.act_margin - G.mkt_margin)[big] == 0
    out["ats_bets_3pt"] = int(big.sum() - push.sum())
    out["ats_winrate_3pt"] = cover[~push].mean()
    bigt = dt.abs() >= 3
    ou = np.sign(dt[bigt]) == np.sign((G.act_total - G.mkt_total)[bigt])
    pusht = (G.act_total - G.mkt_total)[bigt] == 0
    out["ou_bets_3pt"] = int(bigt.sum() - pusht.sum())
    out["ou_winrate_3pt"] = ou[~pusht].mean()
    # TD scorer calibration + Brier vs naive
    P = P.copy()
    out["td_players"] = len(P)
    out["td_brier_model"] = ((P.p_td - P.scored) ** 2).mean()
    base = P.groupby("pos").scored.transform("mean")
    out["td_brier_position_baseline"] = ((base - P.scored) ** 2).mean()
    P["bucket"] = pd.cut(P.p_td, [0, .1, .2, .3, .4, .5, .6, 1])
    cal = P.groupby("bucket", observed=True).agg(n=("scored", "size"), predicted=("p_td", "mean"), actual=("scored", "mean"))
    return out, cal
