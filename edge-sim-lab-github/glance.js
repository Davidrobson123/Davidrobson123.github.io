// Pre-calculate "This week at a glance" when the page is built, so it shows instantly on a phone.
// node glance.js model_week.json viz/glance.json  — same simulator, same typical-game rules as the page (20,000 sims per game, fixed seed)
const fs=require('fs'), path=require('path'); eval(fs.readFileSync(path.join(__dirname,'viz/simcore.js'),'utf8')); const ES=globalThis.EdgeSim;
const [mp, out] = process.argv.slice(2); const M=JSON.parse(fs.readFileSync(mp)); const N=20000, res={};
const med=a=>{ const s=Float32Array.from(a).sort(); return s[Math.floor(0.5*s.length)]; }, mean=a=>{ let t=0; for(const v of a) t+=v; return t/a.length; };
for(const x of M.games){
  let h=2166136261; for(const c of x.id){ h^=c.charCodeAt(0); h=Math.imul(h,16777619)>>>0; }
  const S=ES.simulate(M,x.home,x.away,{n:N,seed:h,neutral:x.neutral,anchor:[x.spread_home,x.total-(x.neutral?1:0)],lineups:x.lineups,restDiff:x.restDiff||0,weather:{roof:x.roof||'outdoors'}});
  const side=t=>{ const r=S.res[t], target=med(r.pts), mtd=mean(r.td); let td=0,fg=0,best=1e9;
    for(let a=0;a<=8;a++) for(let b=0;b<=6;b++){ const c=Math.abs(7*a+3*b-target)+0.8*Math.abs(a-mtd); if(c<best){ best=c; td=a; fg=b; } }
    const top=S.players[t].map(P=>{ let k=0; for(const v of P.td) if(v>=1) k++; return {name:P.p.name, pos:P.p.pos, p:k/N}; }).sort((a,b)=>b.p-a.p)[0];
    return {pts:7*td+3*fg, top}; };
  const A=side(x.away), H=side(x.home); let w=0; for(let i=0;i<N;i++){ const d=S.res[x.home].pts[i]-S.res[x.away].pts[i]; w+=d>0?1:d===0?.5:0; }
  const hw=w/N; if(hw>=.5 && H.pts<=A.pts) H.pts=A.pts+3; if(hw<.5 && A.pts<=H.pts) A.pts=H.pts+3;   // the likelier winner leads, as on the typical-game card
  res[x.id]={hw:+hw.toFixed(4), a:A.pts, h:H.pts, topA:{n:A.top.name,pos:A.top.pos,p:+A.top.p.toFixed(3)}, topH:{n:H.top.name,pos:H.top.pos,p:+H.top.p.toFixed(3)}};
}
fs.writeFileSync(out, JSON.stringify({games:res, built:new Date().toISOString()}));
console.log('glance:', Object.keys(res).length, 'games');
