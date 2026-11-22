"""Playoff chances: simulate the rest of the regular season and the playoffs many times.
   python3 playoffs.py model_week.json viz/playoffs.json [n_seasons]
Remaining games: the betting line where there is one, otherwise the simulator's expected margin from team ratings;
each game's margin is drawn around that (more spread further ahead, for injuries and form). Seeding uses the NFL format
(4 division winners, 3 wild cards per conference) with simplified tie-breakers: head-to-head, division record (division ties),
conference record, points difference, then a coin flip. Playoff games use ratings fitted to the same margins."""
import json, sys, os, subprocess, math, random
import numpy as np, pandas as pd
HERE=os.path.dirname(os.path.abspath(__file__)); mp, outp = sys.argv[1], sys.argv[2]; NS=int(sys.argv[3]) if len(sys.argv)>3 else 10000
DIV={"AFC East":["BUF","MIA","NE","NYJ"],"AFC North":["BAL","CIN","CLE","PIT"],"AFC South":["HOU","IND","JAX","TEN"],"AFC West":["DEN","KC","LV","LAC"],
     "NFC East":["DAL","NYG","PHI","WAS"],"NFC North":["CHI","DET","GB","MIN"],"NFC South":["ATL","CAR","NO","TB"],"NFC West":["ARI","LA","SF","SEA"]}
DIVOF={t:d for d,ts in DIV.items() for t in ts}; CONF={t:d[:3] for t,d in DIVOF.items()}; TEAMS=sorted(DIVOF)
M=json.load(open(mp)); season=int(M["season"])
g=pd.read_parquet(os.path.join(HERE,"data/games.parquet")); g=g[(g.season==season)&(g.game_type=="REG")].copy()
played=g[g.home_score.notna()]; left=g[g.home_score.isna()].reset_index(drop=True)
cur_week=int(left.week.min()) if len(left) else 19
# expected margins for remaining games
need=[[r.home_team,r.away_team] for r in left.itertuples() if pd.isna(r.spread_line)]
json.dump(need,open("/tmp/rem_in.json","w")); subprocess.run(["node",os.path.join(HERE,"remaining.js"),mp,"/tmp/rem_in.json","/tmp/rem_out.json"],check=True)
mm=iter(json.load(open("/tmp/rem_out.json")))
exp=np.array([float(r.spread_line) if pd.notna(r.spread_line) else next(mm) for r in left.itertuples()])
sd=np.array([13.0+0.35*max(0,int(r.week)-cur_week) for r in left.itertuples()])
# team ratings (points vs an average team) fitted to those margins, for the playoff games
HFA=1.8; idx={t:i for i,t in enumerate(TEAMS)}; A=np.zeros((len(left)+32,32)); y=np.zeros(len(left)+32)
for k,r in enumerate(left.itertuples()): A[k,idx[r.home_team]]=1; A[k,idx[r.away_team]]=-1; y[k]=exp[k]-HFA
for t in range(32): A[len(left)+t,t]=0.5   # gentle pull towards average
R=dict(zip(TEAMS,np.linalg.lstsq(A,y,rcond=None)[0]))
Phi=lambda x: 0.5*(1+math.erf(x/math.sqrt(2)))
# fixed results so far
base={t:dict(w=0,l=0,t=0,pf=0,pa=0,dw=0,dl=0,cw=0,cl=0) for t in TEAMS}; h2h={}
def add(res,h,a,hs,as_):
    for t,o,f,ag in ((h,a,hs,as_),(a,h,as_,hs)):
        s=res[t]; s["pf"]+=f; s["pa"]+=ag; win=f>ag; tie=f==ag
        s["w" if win else "t" if tie else "l"]+=1
        if DIVOF[t]==DIVOF[o]: s["dw" if win else "dl"]+= 0 if tie else 1
        if CONF[t]==CONF[o]: s["cw" if win else "cl"]+= 0 if tie else 1
for r in played.itertuples(): add(base,r.home_team,r.away_team,int(r.home_score),int(r.away_score))
base_h2h=[(r.home_team,r.away_team,int(r.home_score)-int(r.away_score)) for r in played.itertuples()]
pct=lambda s:(s["w"]+0.5*s["t"])/max(1,s["w"]+s["l"]+s["t"])
def order(teams,st,res_list,rng,div_tie=False):
    teams=list(teams)
    if len(teams)<=1: return teams
    groups={}; [groups.setdefault(round(pct(st[t]),6),[]).append(t) for t in teams]
    out=[]
    for k in sorted(groups,reverse=True):
        grp=groups[k]
        while len(grp)>1:
            key=lambda t:(sum(1 for h,a,m in res_list if (h==t and a in grp and m>0) or (a==t and h in grp and m<0)) - sum(1 for h,a,m in res_list if (h==t and a in grp and m<0) or (a==t and h in grp and m>0)),
                          (st[t]["dw"]-st[t]["dl"]) if div_tie else 0, st[t]["cw"]-st[t]["cl"], st[t]["pf"]-st[t]["pa"], rng.random())
            best=max(grp,key=key); out.append(best); grp=[t for t in grp if t!=best]
        out+=grp
    return out
def seeds(st,res_list,rng):
    sd_={}
    for c in ("AFC","NFC"):
        winners=[order(DIV[d],st,res_list,rng,True)[0] for d in DIV if d.startswith(c)]
        w_sorted=order(winners,st,res_list,rng); rest=order([t for t in TEAMS if CONF[t]==c and t not in winners],st,res_list,rng)
        sd_[c]=w_sorted+rest[:3]
    return sd_
def pwin(a,b,neutral=False): return Phi((R[a]-R[b]+(0 if neutral else HFA))/13.0)
rng=random.Random(2026); nrng=np.random.default_rng(2026)
cnt={t:dict(po=0,div=0,s1=0,seed=[0]*7,conf=0,sb=0,wins=0.0) for t in TEAMS}
for it in range(NS):
    st={t:dict(v) for t,v in base.items()}; margins=np.rint(nrng.normal(exp,sd)); res_list=list(base_h2h)
    for k,r in enumerate(left.itertuples()):
        m=int(margins[k]); hs=21+max(m,0); as_=21+max(-m,0); add(st,r.home_team,r.away_team,hs,as_); res_list.append((r.home_team,r.away_team,m))
    for t in TEAMS: cnt[t]["wins"]+=st[t]["w"]+0.5*st[t]["t"]
    S=seeds(st,res_list,rng); champs={}
    for c,sl in S.items():
        for i,t in enumerate(sl):
            cnt[t]["po"]+=1; cnt[t]["seed"][i]+=1
            if i<4: cnt[t]["div"]+=1
            if i==0: cnt[t]["s1"]+=1
        alive=[(i+1,t) for i,t in enumerate(sl)]
        wc=[(2,7),(3,6),(4,5)]; nxt=[(1,sl[0])]
        for a,b in wc: ta,tb=sl[a-1],sl[b-1]; nxt.append((a,ta) if rng.random()<pwin(ta,tb) else (b,tb))
        while len(nxt)>1:
            nxt.sort(); games=[(nxt[0],nxt[-1]),(nxt[1],nxt[2])] if len(nxt)==4 else [(nxt[0],nxt[1])]; win=[]
            for (sa,ta),(sb,tb) in games: win.append((sa,ta) if rng.random()<pwin(ta,tb) else (sb,tb))
            nxt=win
        champs[c]=nxt[0][1]; cnt[champs[c]]["conf"]+=1
    a,n_=champs["AFC"],champs["NFC"]; cnt[a if rng.random()<pwin(a,n_,True) else n_]["sb"]+=1
now=seeds({t:dict(v) for t,v in base.items()},base_h2h,random.Random(1))
teams=[dict(t=t,conf=CONF[t],div=DIVOF[t],rec=f'{base[t]["w"]}-{base[t]["l"]}'+(f'-{base[t]["t"]}' if base[t]["t"] else ""),pd_=base[t]["pf"]-base[t]["pa"],
            wins=round(cnt[t]["wins"]/NS,1),po=round(cnt[t]["po"]/NS,4),divp=round(cnt[t]["div"]/NS,4),s1=round(cnt[t]["s1"]/NS,4),
            seed=[round(x/NS,4) for x in cnt[t]["seed"]],confw=round(cnt[t]["conf"]/NS,4),sb=round(cnt[t]["sb"]/NS,4),rating=round(R[t],1)) for t in TEAMS]
json.dump(dict(season=season,week=cur_week,sims=NS,today={c:v for c,v in now.items()},teams=teams,remaining=len(left)),open(outp,"w"))
top=sorted(teams,key=lambda x:-x["sb"])[:5]; print(f"playoffs: {NS} seasons, {len(left)} games left;", ", ".join(f'{x["t"]} SB {x["sb"]*100:.1f}%' for x in top))
