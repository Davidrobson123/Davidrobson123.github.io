"""Keep every prediction made before kick-off, and score the last finished week automatically.
   python3 history.py model_week.json viz/glance.json   →  history/<season>-wNN.json (frozen at kick-off), viz/record.json
A game's saved prediction is only updated while it hasn't started, so what is scored is what the page showed before kick-off."""
import json, sys, os, glob, datetime
import pandas as pd
HERE=os.path.dirname(os.path.abspath(__file__)); m=json.load(open(sys.argv[1])); gl=json.load(open(sys.argv[2]))["games"]
season=int(m["season"]); os.makedirs(os.path.join(HERE,"history"),exist_ok=True)
G=pd.read_parquet(os.path.join(HERE,"data/games.parquet")); G=G[G.season==season]
def kick(gid):
    r=G[G.game_id==gid]
    if not len(r): return None
    r=r.iloc[0]; return datetime.datetime.fromisoformat(f"{r.gameday}T{r.gametime}").replace(tzinfo=datetime.timezone(datetime.timedelta(hours=-5)))  # ET (close enough for a freeze cut-off)
now=datetime.datetime.now(datetime.timezone.utc)
hp=os.path.join(HERE,"history",f"{season}-w{int(m['week']):02d}.json"); H=json.load(open(hp)) if os.path.exists(hp) else {}
saved=0
for gid,s in gl.items():
    k=kick(gid)
    if k is None or now < k - datetime.timedelta(minutes=5):   # still before kick-off: keep the latest prediction
        H[gid]=dict(s, saved=now.strftime("%Y-%m-%d %H:%M UTC")); saved+=1
json.dump(H,open(hp,"w"),indent=0)
# score the most recent week whose games are all finished
best=None
for f in sorted(glob.glob(os.path.join(HERE,"history",f"{season}-w*.json"))):
    H=json.load(open(f)); rows=G[G.game_id.isin(H.keys())]
    if not len(rows) or rows.home_score.isna().any(): continue
    best=(f,H,rows)
rec=None
if best:
    f,H,rows=best; wk=int(rows.week.iloc[0]); fav=0; miss=[]; said=[]; hit=[]
    sp=pd.read_parquet(os.path.join(HERE,f"data/sp{season}.parquet")); sp=sp[sp.week==wk]
    for r in rows.itertuples():
        s=H[r.game_id]; won=1 if r.home_score>r.away_score else 0 if r.home_score<r.away_score else .5
        fav+= (s["hw"]>=.5 and won==1) or (s["hw"]<.5 and won==0)
        miss.append(abs((r.home_score-r.away_score)-(s["h"]-s["a"])))
        for key,tm in (("topA",r.away_team),("topH",r.home_team)):
            pl=sp[(sp.player_display_name==s[key]["n"])&(sp.team==tm)]
            said.append(s[key]["p"]); hit.append(1 if len(pl) and (pl.rushing_tds.iloc[0]+pl.receiving_tds.iloc[0])>0 else 0)
    n=len(rows)
    rec={"title":f"Last week (week {wk}, predicted before kick-off)","items":[["Favourite won",f"{fav} of {n}"],["Typical score: average miss on the margin",f"{sum(miss)/n:.1f} pts"],
         ["Likeliest scorers: said / scored",f"{round(100*sum(said)/len(said))}% / {round(100*sum(hit)/len(hit))}%"]]}
    json.dump(rec,open(os.path.join(HERE,"viz/record.json"),"w"))
print(f"history: {saved} predictions saved for week {m['week']}" + (f"; record: {rec['title']}: " + " · ".join(f'{a} {b}' for a,b in rec['items']) if rec else "; no finished week to score yet"))
