"""Final sanity pass on line-ups (run after export / apply_moves):
   1. the starting QB must be a quarterback on the roster (fallbacks can pick a punter who threw on a fake);
      if not, take the active roster QB with the most career passes (or the first active QB)
   2. every starting QB gets a line-up entry (late starters / new signings have no history with the team)
   3. no pass catcher keeps more than 35% of targets or 45% of receiving yards (inherited roles can
      otherwise pile onto one player); the excess goes to his teammates in proportion
   python3 add_qb_entries.py model.json"""
import json, sys, pandas as pd
d=json.load(open(sys.argv[1])); log=[]
R=pd.read_parquet('data/rw2026.parquet'); R=R[R.week==R.week.max()]
pos={r.gsis_id:r.position for r in R.itertuples()}
passes=pd.concat([pd.read_parquet(f'data/pbp{y}.parquet',columns=['passer_player_id']) for y in (2024,2025,2026)]).passer_player_id.value_counts()
for g in d['games']:
    for t,L in g['lineups'].items():
        q=L.get('qb')
        if q and pos.get(q['id'],'QB')!='QB':
            qbs=R[(R.team==t)&(R.position=='QB')&(R.status=='ACT')]
            if len(qbs):
                best=max(qbs.itertuples(), key=lambda r: passes.get(r.gsis_id,0))
                L['players']=[p for p in L['players'] if p['id']!=q['id'] or p['pos']!='QB']
                log.append(f"{t}: {q['name']} ({pos.get(q['id'])}) is not a QB → {best.full_name}")
                q=L['qb']={'id':best.gsis_id,'name':best.full_name,'changed':True}
        if q and not any(p['id']==q['id'] for p in L['players']):
            others=[p for p in L['players'] if p.get('carry')]; tot=sum(p['carry'] for p in others) or 1
            ent={"id":q['id'],"name":q['name'],"pos":"QB","carry":0.05,"i10":0.03,"rush":0.02,"tgt":0.0,"rz":0.0,"rec":0.0,"cr":0.65,"q":False,"inh":0,"log":[],"tdHit":0}
            for p in others: p['carry']*=(tot-0.05)/tot; p['rush']=p.get('rush',0)*(1-0.02)
            L['players'].append(ent); log.append(f"{t}: added line-up entry for {q['name']}")
        for k,cap in (('tgt',0.35),('rec',0.45)):
            for _ in range(3):
                big=[p for p in L['players'] if (p.get(k) or 0)>cap]
                if not big: break
                excess=sum(p[k]-cap for p in big)
                rest=[p for p in L['players'] if 0.01<(p.get(k) or 0)<=cap and p['pos']!='QB']; tot=sum(p[k] for p in rest)
                for p in big: log.append(f"{t}: {p['name']} {k} {p[k]:.2f} capped at {cap}"); p[k]=cap
                for p in rest: p[k]+=excess*p[k]/tot if tot else 0
json.dump(d,open(sys.argv[1],'w')); print('\n'.join(log))
