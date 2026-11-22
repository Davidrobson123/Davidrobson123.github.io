"""Apply roles.json: set a player's share of targets/yards; teammates give way in proportion (team totals unchanged)."""
import json, sys, os
roles = {tuple(k.split("|")): v for k, v in json.load(open(os.path.join(os.path.dirname(__file__), "roles.json"))).items() if not k.startswith("_")}
d = json.load(open(sys.argv[1]))
# a hand-set role switches itself off once the player has 3+ games with his new team
try:
    import pandas as pd
    sp = pd.read_parquet(os.path.join(os.path.dirname(__file__), "data", f"sp{d['season']}.parquet"))
    for (tm, nm) in list(roles):
        n = int(((sp.player_display_name == nm) & (sp.team == tm)).sum())
        if n >= 3: print(f"role expired: {tm} {nm} has {n} games with the team, using his own numbers"); roles.pop((tm, nm))
except Exception as e: print("role expiry check skipped:", e)
for g in d["games"]:
    for t, L in g["lineups"].items():
        for (tm, nm), R in roles.items():
            me = next((p for p in L["players"] if p["name"] == nm), None) if t == tm else None
            if not me: continue
            for k, v in R.items():
                old = me.get(k, 0) or 0; others = [p for p in L["players"] if p is not me and (p.get(k) or 0) > 0]; tot = sum(p[k] for p in others)
                for p in others: p[k] *= max(tot - (v - old), 0.05) / tot
                me[k] = v
            print(f"role set: {tm} {nm} {R}")
json.dump(d, open(sys.argv[1], "w"))
