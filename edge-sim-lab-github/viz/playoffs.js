// ---------- playoff chances (pre-calculated at build: the rest of the season simulated thousands of times) ----------
let poConf = "AFC";
// bars use whichever team colour shows up on the current background (black for the Steelers or Raiders vanishes in dark mode)
function barColor(ti){ const bg=cssVar("--sunken")||"#e4ecef"; const a=ti.c1, b=ti.c2||ti.c1; try{ return contrast(a,bg)>=2 || contrast(b,bg)<=contrast(a,bg) ? a : b; }catch(e){ return a; } }
function renderPlayoffs(){
  if(!$("#po-table") || typeof PLAYOFFS==="undefined" || !PLAYOFFS){ if($("#po-sub")) $("#po-sub").textContent="Playoff chances will appear after the next data refresh."; return; }
  const P=PLAYOFFS, T=t=>tinfo(t), f=x=>x>=0.995?">99%":x<0.005&&x>0?"<1%":`${Math.round(x*100)}%`;
  $("#po-sub").textContent=`The rest of the ${P.season} regular season and the playoffs simulated ${P.sims.toLocaleString()} times from week ${P.week} (${P.remaining} games left).`;
  const rows=P.teams.filter(t=>t.conf===poConf).sort((a,b)=>b.po-a.po||b.wins-a.wins);
  const heat=s=>`<span class="poheat">${s.map((p,i)=>`<i title="Seed ${i+1}: ${f(p)}" style="background:${p<0.005?"var(--sunken)":`rgba(26,160,120,${(0.18+0.82*Math.min(1,p*1.4)).toFixed(2)})`};color:${p>0.45?"#fff":"var(--ink)"}">${i+1}</i>`).join("")}</span>`;
  const bar=(p,c)=>`<span class="pobar"><span style="width:${Math.max(1,p*100)}%;background:${c}"></span></span>`;
  $("#po-table").innerHTML=`<thead><tr><th>Team</th><th>Record</th><th class="num">Proj. wins</th><th>Playoffs</th><th class="num">Division</th><th class="num">1 seed</th><th>Seeds</th><th class="num"><span class="lgo">Super Bowl</span><span class="smo">SB</span></th></tr></thead><tbody>`+
    rows.map(t=>{ const ti=T(t.t); return `<tr><td>${badge(ti)} <span class="small">${esc(t.div.replace(poConf+" ",""))}</span></td><td class="mono">${esc(t.rec)}</td><td class="num mono">${t.wins.toFixed(1)}</td>
      <td><span class="mono" style="display:inline-block;width:40px">${f(t.po)}</span>${bar(t.po,barColor(ti))}</td><td class="num mono">${f(t.divp)}</td><td class="num mono">${f(t.s1)}</td><td>${heat(t.seed)}</td><td class="num mono">${f(t.sb)}</td></tr>`; }).join("")+"</tbody>";
  // bracket if the season ended today
  const R=Object.fromEntries(P.teams.map(t=>[t.t,t.rating])), pw=(a,b)=>{ const x=(R[a]-R[b]+1.8)/13, t=1/(1+0.2316419*Math.abs(x)), d=0.3989423*Math.exp(-x*x/2), p=d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274)))); return x>0?1-p:p; };
  let s="";
  const side=(c,x0,dir)=>{ const sd=P.today[c]; if(!sd) return; s+=`<text x="${x0+(dir>0?0:260)}" y="24" font-weight="800" font-size="18" fill="var(--ink)" text-anchor="${dir>0?"start":"end"}" font-family="Unbounded, Arial">${c}</text>`;
    const box=(y,seed,t,w)=>{ const ti=T(t), bx=x0; s+=`<g><rect x="${bx}" y="${y}" width="260" height="34" rx="8" fill="${ti.c1}" stroke="var(--line-strong)" stroke-width="1.5"/><text x="${bx+12}" y="${y+22}" fill="${textOn(ti.c1)}" font-size="14" font-weight="800" font-family="Archivo, Arial">${seed}  ${esc(ti.name)}</text>${w!=null?`<text x="${bx+248}" y="${y+22}" fill="${textOn(ti.c1)}" font-size="13" font-weight="700" text-anchor="end" font-family="JetBrains Mono, monospace">${Math.round(w*100)}%</text>`:""}</g>`; };
    box(46,1,sd[0],null); s+=`<text x="${x0+(dir>0?0:260)}" y="96" font-size="12" fill="var(--muted)" text-anchor="${dir>0?"start":"end"}" font-family="Archivo, Arial">First-round bye</text>`;
    [[2,7],[3,6],[4,5]].forEach(([a,b],k)=>{ const y=120+k*100, ta=sd[a-1], tb=sd[b-1], p=pw(ta,tb); box(y,a,ta,p); box(y+40,b,tb,1-p); });
  };
  side("AFC",30,1); side("NFC",710,-1);
  s+=`<g transform="translate(500 230)"><circle r="62" fill="var(--sunken)" stroke="var(--line-strong)"/><text y="-6" text-anchor="middle" font-size="13" font-weight="700" fill="var(--muted)" font-family="Archivo, Arial">SUPER BOWL</text><text y="18" text-anchor="middle" font-size="12" fill="var(--muted)" font-family="Archivo, Arial">favourite</text><text y="40" text-anchor="middle" font-size="18" font-weight="800" fill="var(--ink)" font-family="Unbounded, Arial">${esc([...P.teams].sort((a,b)=>b.sb-a.sb)[0].t)}</text></g>`;
  $("#po-bracket").innerHTML=s;
  // Super Bowl chances
  const top=[...P.teams].sort((a,b)=>b.sb-a.sb).slice(0,12), mx=top[0].sb||1;
  $("#po-sb").innerHTML=top.map(t=>{ const ti=T(t.t); return `<div class="posb">${badge(ti)}<span class="pobar big"><span style="width:${t.sb/mx*100}%;background:${barColor(ti)}"></span></span><span class="mono">${f(t.sb)}</span></div>`; }).join("");
  $("#po-method").textContent="Remaining games use the betting line where there is one, otherwise the sim's team ratings, with more uncertainty the further ahead the game. Tie-breakers are simplified (head-to-head, division record, conference record, points difference), so very close races can differ from the official order.";
}
(function wirePlayoffs(){ if(!$("#v-playoffs")) return;
  document.querySelectorAll("#po-conf button").forEach(b=>b.addEventListener("click",()=>{ poConf=b.dataset.c; document.querySelectorAll("#po-conf button").forEach(x=>x.setAttribute("aria-pressed",x===b)); renderPlayoffs(); }));
  setTimeout(renderPlayoffs, 60);
})();
