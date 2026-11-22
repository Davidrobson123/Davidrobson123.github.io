// ---------- fantasy (private test) ----------
// Every player's fantasy points in every simulated game, built from the same simulations as the rest of the page.
let fRecW = 1, fPos = "ALL", fBusy = false; const fCache = new Map();
const fGames = () => games.filter(g=>!g.custom && !g.started);   // games already kicked off drop out of rankings and start/sit
function fSimAll(done){ const all=fGames(), todo=all.filter(g=>!g.S); if(!todo.length){ done(); return; } if(fBusy) return; fBusy=true; let k=0;
  const step=()=>{ $("#f-info").textContent=`Simulating game ${all.length-todo.length+k+1} of ${all.length}…`;
    setTimeout(()=>{ runSim(todo[k]); k++; if(k<todo.length) step(); else { fBusy=false; renderRibbon(); done(); } }, 15); };
  step(); }
function fEveryone(){ const out=[]; fGames().forEach(g=>{ if(!g.S) return; const S=g.S;
  for(const t of [S.home,S.away]) for(const P of S.players[t]){ const home=t===g.home.abbr;
    out.push({P, g, id:g.id+"|"+P.p.id, name:P.p.name, pos:P.p.pos, tm:home?g.home:g.away, opp:home?g.away:g.home, home}); } }); return out; }
function fSamples(x){ const key=fRecW+"|"+x.id+"|"+x.g.runId; if(fCache.has(key)) return fCache.get(key);
  const P=x.P, n=P.rush.length, o=new Float32Array(n);
  for(let i=0;i<n;i++) o[i]=0.1*(P.rush[i]+P.rec[i]) + fRecW*P.recs[i] + 6*P.td[i] + (P.pass? 0.04*P.pass[i] + 4*(P.ptd? P.ptd[i] : 0) : 0);
  fCache.set(key,o); return o; }
const fSorted=new Map();
function fQ(x){ const key=fRecW+"|"+x.id+"|"+x.g.runId; if(!fSorted.has(key)){ const s=Float32Array.from(fSamples(x)).sort(); fSorted.set(key,s); }
  const s=fSorted.get(key), at=p=>s[Math.min(s.length-1,Math.floor(p*s.length))]; return [at(.1),at(.5),at(.9)]; }
const f1 = v => (Math.round(v*10)/10).toFixed(1);
function renderFantasy(){
  if(!$("#f-table")) return; const all=fEveryone(); const done=fGames().filter(g=>g.S).length, tot=fGames().length;
  $("#f-info").textContent = done<tot ? `${done} of ${tot} games simulated` : `${tot} games · ${nSims.toLocaleString()} sims each`;
  const rows=all.filter(x=>fPos==="ALL"||x.pos===fPos).map(x=>{ const q=fQ(x); let td=0; for(const v of x.P.td) if(v>=1) td++; return {x,q,td:td/x.P.td.length}; })
    .filter(r=>r.q[1]>0.5).sort((a,b)=>b.q[1]-a.q[1]).slice(0,80);
  const mx=Math.max(1,...rows.map(r=>r.q[2]));
  $("#f-table").innerHTML = `<thead><tr><th class="num">#</th><th>Player</th><th>Team</th><th>Opp</th><th class="num">Median</th><th>Floor – ceiling</th><th class="num">TD chance</th></tr></thead><tbody>`+
    rows.map((r,i)=>`<tr><td class="num mono">${i+1}</td><td><strong>${esc(r.x.name)}</strong> <span class="small">${esc(r.x.pos)}</span></td><td>${badge(r.x.tm)}</td>
      <td><span class="small">${r.x.home?"v":"@"}</span> ${badge(r.x.opp)}</td><td class="num mono"><strong>${f1(r.q[1])}</strong></td>
      <td class="mono small">${f1(r.q[0])} – ${f1(r.q[2])}${rangeBar(r.q,mx)}</td><td class="num mono">${pct(r.td)}</td></tr>`).join("")+"</tbody>";
  // start / sit pickers
  fOpts=all.slice().sort((a,b)=>fQ(b)[1]-fQ(a)[1]).filter(x=>fQ(x)[1]>0.5).map(x=>({id:x.id, label:`${x.name} (${x.pos}, ${x.tm.abbr})`, key:fNorm(`${x.name} ${x.pos} ${x.tm.abbr} ${x.tm.name}`)}));
  fFill("a"); fFill("b");
  renderSS();
}
// search boxes: typing narrows each list to matching players (name, position, team), best players first
let fOpts=[];
const fNorm = s => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9 ]/g," ");
function fFill(side){
  const sel=$("#f-ss"+side), q=fNorm($("#f-q"+side).value||"").trim(), words=q.split(/\s+/).filter(Boolean), cur=sel.value;
  const list=fOpts.filter(o=>words.every(w=>o.key.includes(w)));
  sel.innerHTML = list.length ? list.slice(0,150).map(o=>`<option value="${esc(o.id)}">${esc(o.label)}</option>`).join("") : `<option value="">No player matches "${esc($("#f-q"+side).value)}"</option>`;
  if(list.some(o=>o.id===cur)) sel.value=cur; else if(list.length){ const other=$("#f-ss"+(side==="a"?"b":"a")).value; const pick=list.find(o=>o.id!==other)||list[0]; sel.value=pick.id; }
}
function renderSS(){
  const all=fEveryone(), A=all.find(x=>x.id===$("#f-ssa").value), B=all.find(x=>x.id===$("#f-ssb").value); if(!A||!B) return;
  if(A.id===B.id){ $("#f-ssres").innerHTML=`<p class="sub" style="margin-top:12px">Pick two different players.</p>`; return; }
  const a=fSamples(A), b=fSamples(B); let w;
  if(A.g===B.g){ let c=0,t=0; const n=Math.min(a.length,b.length); for(let i=0;i<n;i++){ if(a[i]>b[i]) c++; else if(a[i]===b[i]) t++; } w=(c+t/2)/n; }   // same game: compare game by game
  else { const sa=Float32Array.from(a).sort(), sb=Float32Array.from(b).sort(); let j=0, k=0, cnt=0;     // different games: independent
    for(let i=0;i<sa.length;i++){ while(j<sb.length && sb[j]<sa[i]) j++; k=j; while(k<sb.length && sb[k]===sa[i]) k++; cnt+=j+(k-j)/2; } w=cnt/(sa.length*sb.length); }
  const lead=w>=.5?A:B, pw=Math.max(w,1-w), qa=fQ(A), qb=fQ(B);
  $("#f-ssres").innerHTML = `<div style="margin-top:14px;font-size:1.15rem"><strong>Start ${esc(lead.name)}</strong>: outscores in ${pct(pw)} of simulations</div>
    <div class="grid g2" style="margin-top:10px"><div class="small">${esc(A.name)}: median <span class="mono">${f1(qa[1])}</span>, floor ${f1(qa[0])}, ceiling ${f1(qa[2])}</div>
    <div class="small">${esc(B.name)}: median <span class="mono">${f1(qb[1])}</span>, floor ${f1(qb[0])}, ceiling ${f1(qb[2])}</div></div>
    ${pw<.56?`<p class="sub" style="margin-top:8px">Close to a coin flip: go with the matchup or your gut.</p>`:""}`;
}
(function wireFantasy(){ if(!$("#v-fantasy")) return;
  document.querySelectorAll("#f-scoring button").forEach(b=>b.addEventListener("click",()=>{ fRecW=+b.dataset.w; document.querySelectorAll("#f-scoring button").forEach(x=>x.setAttribute("aria-pressed",x===b)); renderFantasy(); }));
  document.querySelectorAll("#f-pos button").forEach(b=>b.addEventListener("click",()=>{ fPos=b.dataset.p; document.querySelectorAll("#f-pos button").forEach(x=>x.setAttribute("aria-pressed",x===b)); renderFantasy(); }));
  ["#f-ssa","#f-ssb"].forEach(s=>$(s).addEventListener("change",renderSS));
  for(const side of ["a","b"]) $("#f-q"+side).addEventListener("input",()=>{ fFill(side); renderSS(); });
  const show=()=>{ if(location.hash==="#fantasy") fSimAll(renderFantasy); };
  window.addEventListener("hashchange",show); setTimeout(show,80);
})();
