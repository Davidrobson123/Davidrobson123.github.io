"""Safety checks before anything is published. Exits with an error (so the last good page stays live and GitHub
emails the owner) if the data looks wrong.   python3 checks.py model_week.json viz/glance.json [viz/playoffs.json]"""
import json, sys, math
fail=[]; warn=[]
m=json.load(open(sys.argv[1])); gl=json.load(open(sys.argv[2]))["games"]
po=json.load(open(sys.argv[3])) if len(sys.argv)>3 else None
imp=lambda a: 100/(a+100) if a>0 else -a/(-a+100)
if not m.get("games"): fail.append("no games in this week's data")
for g in m["games"]:
    for t,L in g["lineups"].items():
        q=L.get("qb")
        if not q: fail.append(f"{g['id']} {t}: no starting quarterback")
        elif not any(p["id"]==q["id"] and p["pos"]=="QB" for p in L["players"]): fail.append(f"{g['id']} {t}: starting QB {q['name']} missing or not a QB")
        tg=sum(p.get("tgt",0) or 0 for p in L["players"]); ca=sum(p.get("carry",0) or 0 for p in L["players"])
        if not 0.55<=tg<=1.2: fail.append(f"{g['id']} {t}: target shares add up to {tg:.2f}")
        if not 0.55<=ca<=1.2: fail.append(f"{g['id']} {t}: carry shares add up to {ca:.2f}")
        if len(L["players"])<6: fail.append(f"{g['id']} {t}: only {len(L['players'])} players")
    s=gl.get(g["id"])
    if not s: fail.append(f"{g['id']}: not simulated"); continue
    if not (0<=s["a"]<=70 and 0<=s["h"]<=70): fail.append(f"{g['id']}: odd typical score {s['a']}-{s['h']}")
    o=g.get("odds") or {}
    if o.get("mlHome") and o.get("mlAway"):
        ph,pa=imp(o["mlHome"]),imp(o["mlAway"]); mk=ph/(ph+pa)
        if abs(s["hw"]-mk)>0.15: fail.append(f"{g['id']}: sim win chance {s['hw']:.0%} far from the market's {mk:.0%}")
        elif abs(s["hw"]-mk)>0.08: warn.append(f"{g['id']}: sim {s['hw']:.0%} v market {mk:.0%}")
if po:
    for c in ("AFC","NFC"):
        tot=sum(sum(t["seed"]) for t in po["teams"] if t["conf"]==c)
        if abs(tot-7)>0.05: fail.append(f"playoffs: {c} seed chances add up to {tot:.2f}, not 7")
    if abs(sum(t["sb"] for t in po["teams"])-1)>0.02: fail.append("playoffs: Super Bowl chances don't add up to 100%")
for w in warn: print("note:", w)
if fail:
    print("CHECKS FAILED, nothing published:"); [print(" -", f) for f in fail]; sys.exit(1)
print(f"checks passed: {len(m['games'])} games" + (", playoffs" if po else ""))
