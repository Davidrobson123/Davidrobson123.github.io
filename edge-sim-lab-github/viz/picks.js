window.__FIXED = true;   // betting page: fixed simulations per game, so picks don't change on reload
// ---------- PICKS PREVIEW (private build only) ----------
const RULES = { minProb: 0.25, minGapPts: 0.03, maxInherit: 0.4, minEV: 0.03, minEVPlayer: 0.07, leanFrac: 0.6, maxGap: 0.12, wSide: 0.5, wProp: 0.7, kelly: 0.25, cap: 0.02, oneWayMargin: 1.06, needConsensus: true };
const PRICE_SRC = { // where the market chances come from (margin removed); per game id
};
// Player prices per game id: {td:{name:price}, props:[[name, stat, line, overPrice, underPrice]]}.
// Week 9: books haven't posted anytime TD or yardage lines yet. Type prices into each game's boxes below.
const PREFILL = {
};
// Several bookmakers' anytime-TD quotes per game id, gathered from tipster pages. UK sites (bet365 News,
// Oddschecker) refuse automated reads, so these are US books. Two or more quotes = a consensus.
const TD_SRC = {}; // per game id: where single anytime-TD prices came from
const QUOTES = {
};
function consensus(qs){ const ds=qs.map(q=>toDec(q[0])).filter(Boolean); if(!ds.length) return null;
  const imp = ds.reduce((a,d)=>a+1/d,0)/ds.length; return {dec:1/imp, imp, n:ds.length, books:qs.map(q=>q[1])}; }
const PK = {}; // per game: {td:{name:price}, props:[...], legs:[bet builder legs] | null until examples are loaded, example:bool}
function pkState(g){ const id=g.id||("custom-"+g.home.abbr+g.away.abbr); if(!PK[id]){ const P=PREFILL[g.id]||{};
  PK[id]={td:Object.assign({},P.td||{}), props:(P.props||[]).map(x=>({name:x[0],stat:x[1],line:x[2],ov:x[3],un:x[4]})), legs:null, example:false}; } return PK[id]; }
function toDec(str){ if(str===undefined||str===null) return null; const s=String(str).trim(); if(!s) return null;
  if(s.includes("/")){ const [a,b]=s.split("/").map(Number); return b? 1+a/b : null; }
  const x=parseFloat(s); if(!isFinite(x)) return null;
  if(s.startsWith("+")||s.startsWith("-")||Math.abs(x)>=100) return x>0? 1+x/100 : 1+100/Math.abs(x);
  return x>1? x : null; }
const amTxt = d => d>=2? "+"+Math.round((d-1)*100) : "-"+Math.round(100/(d-1));
function bankroll(){ return Math.max(0, parseFloat(($("#bank")||{}).value)||100); }

function playerArr(g, name){ for(const t of [g.home.abbr,g.away.abbr]){ const P=(g.S.players[t]||[]).find(x=>x.p.name===name); if(P) return P; } return null; }
// win / push masks over the simulated games
function maskFor(g, spec){
  const H=g.S.res[g.home.abbr], A=g.S.res[g.away.abbr], n=g.S.n, win=new Uint8Array(n), push=new Uint8Array(n);
  for(let i=0;i<n;i++){
    const m=H.pts[i]-A.pts[i], tot=H.pts[i]+A.pts[i]; let w=0, p=0;
    switch(spec.k){
      case "mlH": w=m>0; p=m===0; break;
      case "mlA": w=m<0; p=m===0; break;
      case "spH": w=m>spec.line; p=m===spec.line; break;      // home favoured by `line` (nflverse spread_line)
      case "spA": w=m<spec.line; p=m===spec.line; break;
      case "ov": w=tot>spec.line; p=tot===spec.line; break;
      case "un": w=tot<spec.line; p=tot===spec.line; break;
      default: {
        const P=spec.P; if(!P){ break; }
        if(spec.k==="td"){ w=P.td[i]>=1; break; }
        const v = spec.k==="rush"?P.rush[i]: spec.k==="rec"?P.rec[i]: spec.k==="recs"?P.recs[i]: (P.pass?P.pass[i]:0);
        w = spec.side==="over" ? v>spec.line : v<spec.line; p = v===spec.line;
      }
    }
    win[i]=w?1:0; push[i]=p?1:0;
  }
  return {win,push};
}
function modelP(g, spec){ const {win,push}=maskFor(g,spec); let w=0,p=0; for(let i=0;i<win.length;i++){ w+=win[i]; p+=push[i]; } const n=win.length-p; return n>0? w/n : 0; }
function evaluate(row){ // row: {pModel, pMkt (market chance with the margin removed), kind:"side"|"prop"}
  // Picks are judged against the most accurate market odds (no margin), not one bookmaker's price.
  // Each pick gets a "take at" price: the lowest price in your own app that still gives +5% on the blended chance.
  if(row.pMkt==null) return Object.assign(row,{status:"no price"});
  const w = row.kind==="side"? RULES.wSide : RULES.wProp, pb = w*row.pModel + (1-w)*row.pMkt, gap = row.pModel-row.pMkt;
  const th = row.kind==="side"? RULES.minEV : RULES.minEVPlayer, fairMkt = 1/row.pMkt, takeAt = (1+th)/pb, ev = pb*fairMkt-1;          // ev = edge vs the margin-free market
  const b=takeAt-1, kel=Math.max(0,(b*pb-(1-pb))/b), stake=Math.floor(Math.min(RULES.cap, RULES.kelly*kel)*bankroll()*2)/2;
  // A pick must clear EVERY test; anything with an edge that fails one is a lean, with the reason shown.
  const minProb = Math.max(0, Math.min(0.95, (parseFloat(($("#minprob")||{}).value)||RULES.minProb*100)/100));
  const why = [], tests = [];
  const per100 = x => Math.round(x*100);
  tests.push({ok: row.pModel >= minProb, t:`Lands often enough: wins in ${per100(row.pModel)} of every 100 simulated games (needs ${per100(minProb)})`});
  tests.push({ok: gap >= RULES.minGapPts, t: gap>=0 ? `Clearly ahead of the market: the simulation gives it ${per100(row.pModel)}%, the market ${per100(row.pMkt)}% (needs 3 points ahead)` : `Behind the market: the simulation gives it ${per100(row.pModel)}%, the market ${per100(row.pMkt)}%`});
  tests.push({ok: ev >= th, t: ev>=0 ? `Worth the price: about ${Math.round(ev*100)}p profit expected per £1 at a fair market price (needs ${Math.round(th*100)}p for ${row.kind==="side"?"game lines":"player bets"})` : `Not worth the price: expected to lose about ${Math.round(-ev*100)}p per £1 at a fair market price`});
  tests.push({ok: row.src !== "single" || !RULES.needConsensus, t: row.src==="single" ? "Market price from one bookmaker only, so the market side isn't reliable yet" : row.src==="exchange" ? "Market price from a betting exchange (no bookmaker margin), which counts as reliable" : `Market price is a consensus of several bookmakers${row.srcNote? " ("+row.srcNote+")":""}`});
  tests.push({ok: (row.inh||0) < RULES.maxInherit, t: (row.inh||0) >= 0.05 ? `${per100(row.inh||0)}% of his work tonight is an injured teammate's (limit 40%)` : "His role is his own, not an injured teammate's"});
  if (Math.abs(gap) > RULES.maxGap) tests.unshift({ok:false, warn:true, t:`The simulation and the market are ${Math.abs(per100(gap))} points apart. Gaps this big usually mean the model is missing news: check before betting`});
  if (row.pModel < minProb) why.push(`lands ${pct(row.pModel,0)}, under the ${pct(minProb,0)} minimum`);
  if (gap < RULES.minGapPts) why.push(`only ${(gap*100).toFixed(1)} pts ahead of the market`);
  if (row.src === "single" && RULES.needConsensus) why.push("market price from one bookmaker, not a consensus");
  if ((row.inh||0) >= RULES.maxInherit) why.push(`${pct(row.inh,0)} of his role is an injured teammate's work`);
  let status = Math.abs(gap)>RULES.maxGap ? "check" : ev < th ? (ev >= th*RULES.leanFrac ? "lean" : "pass") : (why.length ? "lean" : "pick");
  if (status==="lean" && ev < th) why.unshift(`edge ${pct(ev,1)}, just under the +${Math.round(th*100)}% needed`);
  return Object.assign(row,{pBlend:pb, ev, gap, takeAt, fairMkt, why, tests, stake: status==="pick"? Math.max(0.5, stake): 0, status});   // a pick always carries at least 50p
}
const STATUS = { pick:["Pick","good"], lean:["Lean","meh"], pass:["No bet",""], check:["Check news","bad"], "no price":["Add price",""] };
function badgeS(st){ const [t,c]=STATUS[st]||["",""]; return `<span class="stp ${c}">${t}</span>`; }

function gameRows(g){
  const o=g.oddsRaw||{}, sl=g.market?g.market.spread_home:null, tl=g.market?g.market.total:null, rows=[];
  const two=(a,b)=>{ const da=toDec(a), db=toDec(b); if(!da||!db) return [null,null]; const pa=1/da, pb=1/db; return [pa/(pa+pb), pb/(pa+pb)]; };
  const hA=g.home.abbr, aA=g.away.abbr;
  if(o.mlHome!=null&&o.mlAway!=null){ const [ph,pa]=two(o.mlHome,o.mlAway);
    rows.push({key:"mlH",label:`${hA} to win`,spec:{k:"mlH"},dec:toDec(o.mlHome),pMkt:ph,kind:"side"});
    rows.push({key:"mlA",label:`${aA} to win`,spec:{k:"mlA"},dec:toDec(o.mlAway),pMkt:pa,kind:"side"}); }
  if(sl!=null&&o.spreadHome!=null){ const [ph,pa]=two(o.spreadHome,o.spreadAway); const fav=sl>=0;
    rows.push({key:"spH",label:`${hA} ${sl>0?"-":"+"}${Math.abs(sl)}`,spec:{k:"spH",line:sl},dec:toDec(o.spreadHome),pMkt:ph,kind:"side"});
    rows.push({key:"spA",label:`${aA} ${sl>0?"+":"-"}${Math.abs(sl)}`,spec:{k:"spA",line:sl},dec:toDec(o.spreadAway),pMkt:pa,kind:"side"}); }
  if(tl!=null&&o.over!=null){ const [po,pu]=two(o.over,o.under);
    rows.push({key:"ov",label:`Over ${tl}`,spec:{k:"ov",line:tl},dec:toDec(o.over),pMkt:po,kind:"side"});
    rows.push({key:"un",label:`Under ${tl}`,spec:{k:"un",line:tl},dec:toDec(o.under),pMkt:pu,kind:"side"}); }
  rows.forEach(r=>{ r.src="consensus"; r.pModel=modelP(g,r.spec); evaluate(r); });
  return rows;
}
function tdRows(g){ const st=pkState(g);
  const names = g.players.filter(p=>p.td>=0.03).map(p=>p.name);
  Object.keys(st.td).forEach(nm=>{ if(!names.includes(nm) && playerArr(g,nm)) names.push(nm); });
  const Q = QUOTES[g.id] || {};
  Object.keys(Q).forEach(nm=>{ if(!names.includes(nm) && playerArr(g,nm)) names.push(nm); });
  return names.map(nm=>{ const P=playerArr(g,nm); const own=(st.tdOwn||{})[nm];
    const c = !own && Q[nm] ? consensus(Q[nm]) : null;
    const pr = own || (c ? c.dec.toFixed(2) : (st.td[nm]||"")), isPct = /%\s*$/.test(pr), pp = isPct? parseFloat(pr)/100 : null;
    const dec = isPct? (pp>0? 1/pp : null) : toDec(pr);
    const src = c && c.n >= 2 ? "consensus" : (!own && !c && isPct) ? "exchange" : "single";
    const r={key:"td:"+nm,label:`${nm} anytime TD`,name:nm,spec:{k:"td",P},
      priceStr:pr, dec, pMkt: isPct? (pp>0? pp : null) : dec? (1/dec)/RULES.oneWayMargin : null, kind:"prop", missing:!P, src, srcNote: c? `${c.n} price${c.n>1?"s":""}: ${c.books.join(", ")}` : own? "your price" : (st.td[nm]? "1 price: "+(TD_SRC[g.id]||"SBD (book not named)")+(isPct? " (no margin)":"") : ""),
      inh: P? (P.p.inh||0) : 0};
    r.pModel = P? modelP(g,r.spec) : 0; return evaluate(r); }).sort((a,b)=>b.pModel-a.pModel);
}
function propRows(g){ const st=pkState(g), out=[];
  const statName={rush:"rushing yds",rec:"receiving yds",recs:"receptions",pass:"passing yds"};
  st.props.forEach((x,ix)=>{ const P=playerArr(g,x.name); const dov=toDec(x.ov), dun=toDec(x.un);
    let po=null,pu=null; if(dov&&dun){ const a=1/dov,b=1/dun; po=a/(a+b); pu=b/(a+b); }
    for(const side of ["over","under"]){
      const r={key:`pr:${ix}:${side}`,ix,label:`${x.name} ${side} ${x.line} ${statName[x.stat]}`,name:x.name,side,spec:{k:x.stat,P,side,line:+x.line},
        dec: side==="over"?dov:dun, pMkt: side==="over"?po:pu, kind:"prop", missing:!P, src:"single", inh: P? (P.p.inh||0) : 0};
      r.pModel = P? modelP(g,r.spec) : 0; out.push(evaluate(r)); } });
  return out;
}
// House rule: no bets on Thursday-night games (least information, short week, late inactives). Their bets are
// still shown and judged, but can't be picks or leans.
function isThursday(g){ const k=(g&&(g.kickRaw||g.kickoff))||""; const m=/^(Thu|Fri) .* (\d{1,2}):\d{2}/.exec(k.replace(/^.*?(Thu|Fri)/,"$1")); return !!m && (m[1]==="Thu" || +m[2] < 6); }
function thursdaySkip(g, rows){
  if(g && g.started){ rows.forEach(r=>{ if(r.status!=="no price"){ r.status="pass"; r.stake=0; r.why=["Already kicked off: no bets once a game has started"]; } }); return rows; }
  if(!isThursday(g)) return rows;
  rows.forEach(r=>{ if(r.status==="pick"||r.status==="lean"){ r.status="pass"; r.stake=0; r.why=["Thursday game: we don't bet these"]; } }); return rows; }
function dedupePicks(rows){ const best={}, k=r=>r.name||(r.kind==="side"? "game lines" : r.key);
  rows.filter(r=>r.status==="pick").forEach(r=>{ const key=k(r); if(!best[key]||r.ev>best[key].ev) best[key]=r; });
  rows.forEach(r=>{ if(r.status==="pick" && best[k(r)]!==r){ r.status="lean"; r.stake=0; r.why=[`a stronger pick on ${r.name? "the same player" : "this game"} is listed`]; } });
  return rows; }
function oneBetPerPlayer(rows){ const best={}; rows.filter(r=>r.status==="pick").forEach(r=>{ const k=r.name||r.key; if(!best[k]||r.ev>best[k].ev) best[k]=r; });
  return Object.values(best).sort((a,b)=>b.ev-a.ev); }

function rowHtml(r, st, extra){
  const tick = `<input type="checkbox" class="bbt" data-k="${esc(r.key)}" ${hasLeg(st, rowLeg(games[gi], r))?"checked":""} aria-label="Add ${esc(r.label)} to bet builder">`;
  const mkt = r.pMkt==null? "–" : pct(r.pMkt,1), ev = r.ev==null? "–" : (r.ev>=0?"+":"")+pct(r.ev,1);
  return `<tr class="${r.status==="pick"?"pkrow":""}"><td>${tick}</td><td><strong>${esc(r.label)}</strong>${r.missing?' <span class="small">(not in the simulation)</span>':""}${(r.inh||0)>=0.25?` <span class="qtag" title="Share of this player's work tonight that comes from teammates ruled out">${Math.round(r.inh*100)}% INHERITED</span>`:""}${r.status==="lean"&&r.why&&r.why.length?`<div class="small">${esc(r.why.join("; "))}</div>`:""}</td>${extra||""}
    <td class="num mono">${pct(r.pModel,1)}</td><td class="num mono">${mkt}</td>
    <td class="num mono">${r.gap==null?"–":(r.gap>=0?"+":"")+(r.gap*100).toFixed(1)}</td><td class="num mono">${ev}</td>
    <td class="num mono">${r.takeAt&&r.status!=="check"? `<strong>${r.takeAt.toFixed(2)}</strong> <span class="small">${fracTxt(r.takeAt)}</span>`:"–"}</td>
    <td>${badgeS(r.status)}</td><td class="num mono">${r.stake? "£"+r.stake.toFixed(2):""}</td></tr>`;
}
const HEAD = (first) => `<thead><tr><th></th><th>Bet</th>${first||""}<th class="num">Sim chance</th><th class="num">Market chance</th><th class="num">Gap (pts)</th><th class="num">Edge vs market</th><th class="num">Take at or above</th><th>Verdict</th><th class="num">Stake</th></tr></thead>`;
const UKF = "1/5 2/9 1/4 2/7 3/10 1/3 4/11 2/5 4/9 1/2 8/15 4/7 8/13 4/6 8/11 4/5 5/6 10/11 1/1 11/10 6/5 5/4 11/8 6/4 13/8 7/4 15/8 2/1 9/4 5/2 11/4 3/1 10/3 7/2 4/1 9/2 5/1 11/2 6/1 13/2 7/1 15/2 8/1 9/1 10/1 11/1 12/1 14/1 16/1 20/1 25/1 33/1 40/1 50/1".split(" ");
function fracTxt(d){ for(const f of UKF){ const [a,b]=f.split("/").map(Number); if(1+a/b >= d-1e-9) return f; } return Math.round(d-1)+"/1"; } // smallest standard UK price at or above d

function fracNear(d){ if(!isFinite(d)) return "–"; let best=UKF[0], e=1e9; for(const f of UKF){ const [a,b]=f.split("/").map(Number), x=Math.abs(Math.log((1+a/b)/d)); if(x<e){ e=x; best=f; } } return best; } // nearest standard UK price
function checklist(r){
  const [vt, vc] = STATUS[r.status] || ["",""];
  const head = r.status==="pick" ? `Take at ${r.takeAt.toFixed(2)} (${fracTxt(r.takeAt)}) or better · suggested stake £${r.stake.toFixed(2)}`
    : r.status==="check" ? "Check team news before going near this" : r.status==="lean" ? "Close, but fails a test" : "No edge at this price";
  return `<div class="ck ${r.status}"><div class="ck-h"><strong>${esc(r.label)}</strong>${badgeS(r.status)}</div>
    <div class="small" style="margin:2px 0 8px">${esc(head)}</div>
    <ul class="ck-l">${(r.tests||[]).map(x=>`<li class="${x.ok?"ok":x.warn?"warn":"no"}"><span aria-hidden="true">${x.ok?"✓":x.warn?"!":"✗"}</span><span>${esc(x.t)}</span></li>`).join("")}</ul></div>`;
}
function renderPicks(){
  if(!$("#v-picks")) return;
  const g=games[gi]; if(!g.S) return; const st=pkState(g);
  $("#pricesrc").textContent = PRICE_SRC[g.id] || (g.custom? "Custom matchup: no market prices. Enter prices below." : "Game prices: nflverse closing-line feed ⚠️. No prop prices yet: type them in.");
  const G=g.custom? [] : gameRows(g), T=tdRows(g), Pp=propRows(g); thursdaySkip(g, dedupePicks([...G,...T,...Pp]));
  $("#pk-game").innerHTML = G.length? HEAD()+"<tbody>"+G.map(r=>rowHtml(r,st)).join("")+"</tbody>" : `<tbody><tr><td class="small">No game prices for this matchup.</td></tr></tbody>`;
  $("#pk-td").innerHTML = HEAD(`<th>Market price</th>`)+"<tbody>"+T.map(r=>rowHtml(r,st,`<td><input type="text" class="tdp" data-n="${esc(r.name)}" value="${esc(r.priceStr)}" placeholder="e.g. 2.25" style="width:90px"><div class="small">${esc(r.srcNote||"")}</div></td>`)).join("")+"</tbody>";
  $("#pk-props").innerHTML = Pp.length? HEAD()+"<tbody>"+Pp.map(r=>rowHtml(r,st)).join("")+"</tbody>" : `<tbody><tr><td class="small">No lines yet. Add one below.</td></tr></tbody>`;
  // summary
  const all=[...G,...T,...Pp], picks=oneBetPerPlayer(all);
  const seen=new Set(), checks=all.filter(r=>r.status==="check"&&r.dec&&r.gap>0).filter(r=>{ const k=r.ix!==undefined? "p"+r.ix : r.key.slice(0,2); if(seen.has(k)) return false; seen.add(k); return true; });
  const total=picks.reduce((a,r)=>a+r.stake,0);
  const leans = all.filter(r=>r.status==="lean").sort((a,b)=>b.pModel-a.pModel);
  $("#picksum").innerHTML = `<div class="label" style="margin-bottom:6px">${badge(g.away)} at ${badge(g.home)} · ${picks.length} pick${picks.length===1?"":"s"} · £${total.toFixed(2)} suggested stake</div>`+
    (picks.length? `<ul class="inj">${picks.map(r=>`<li><strong>${esc(r.label)}</strong> <span class="mono">· take at ${r.takeAt.toFixed(2)} (${fracTxt(r.takeAt)}) or above</span> <span class="small">· sim ${pct(r.pModel,0)} vs market ${pct(r.pMkt,0)} · stake £${r.stake.toFixed(2)}</span> <button class="btn pkadd" type="button" data-k="${esc(r.key)}" ${hasLeg(st,rowLeg(g,r))?"disabled":""}>${hasLeg(st,rowLeg(g,r))?"In builder":"Add to builder"}</button></li>`).join("")}</ul>
      <p class="small" style="margin-top:6px">Open your betting app: if its price is at or above the "take at" price, it qualifies. Below it, skip. Picks near the +5% line can switch between runs: use 50,000 simulations before relying on one.</p>` : `<p class="sub">No picks. Nothing clears every test at these prices, which is the normal result when the model and the market broadly agree.</p>`)+
    (leans.length? `<p class="small" style="margin-top:6px">${leans.length} close call${leans.length===1?"":"s"} (leans) not picked: open "How each bet was judged" below to see why.</p>`:"")+
    (checks.length? `<details class="verdict bad" style="margin-top:8px"><summary style="cursor:pointer">Check team news on ${checks.length} bet${checks.length===1?"":"s"} before betting</summary><p class="small" style="margin:6px 0 0;font-weight:400">${checks.map(r=>esc(r.label)).join(", ")}. The simulation and the market disagree by more than 12 points on these, which usually means the model is missing something.</p></details>`:"");
  // plain-language checklists: every pick, then the closest calls
  const ranked = all.filter(r=>r.status!=="no price" && r.tests).sort((a,b)=>{ const o={pick:0,lean:1,check:2,pass:3}; return (o[a.status]-o[b.status]) || (b.tests.filter(t=>t.ok).length - a.tests.filter(t=>t.ok).length) || (b.pModel-a.pModel); });
  const showN = +(($("#cknum")||{}).value||8);
  $("#pk-checks").innerHTML = ranked.slice(0, showN).map(checklist).join("") || `<p class="sub">No priced bets yet.</p>`;
  // builder
  if(st.legs===null){ st.legs=exampleFor(g); st.example=true; }
  if(bbGame!==g){ bbGame=g; refreshLegForm(); }
  renderBuilder();
  // wiring
  const toggle=(r,on)=>{ const L=rowLeg(g,r); if(st.example){ st.legs=[]; st.example=false; }
    if(on){ if(!hasLeg(st,L)) st.legs.push(L); } else st.legs=st.legs.filter(x=>legKey(x)!==legKey(L)); renderPicks(); };
  document.querySelectorAll("#v-picks .bbt").forEach(cb=>cb.addEventListener("change",()=>{ const r=all.find(x=>x.key===cb.dataset.k); if(r) toggle(r,cb.checked); }));
  document.querySelectorAll("#v-picks .pkadd").forEach(b=>b.addEventListener("click",()=>{ const r=all.find(x=>x.key===b.dataset.k); if(r){ toggle(r,true); $("#bb-legs").scrollIntoView({behavior:"smooth",block:"center"}); } }));
  document.querySelectorAll("#v-picks .tdp").forEach(inp=>inp.addEventListener("change",()=>{ st.tdOwn=st.tdOwn||{}; if(inp.value.trim()) st.tdOwn[inp.dataset.n]=inp.value; else delete st.tdOwn[inp.dataset.n]; renderPicks(); }));
  const sel=$("#ap-pl"); if(sel){ const cur=sel.value; sel.innerHTML=g.players.map(p=>`<option>${esc(p.name)}</option>`).join(""); if(cur) sel.value=cur; }
  renderBoard();
}
// ---------- all games, ranked ----------
// Every game this week through the same tests, in one list: picks, then leans, then check news, then passes,
// highest simulated chance first within each group. Prices typed into a game's boxes flow in here too.
const BD_ORDER = {pick:0, lean:1, check:2, pass:3, "no price":4};
let bdBusy = false;
function boardGames(){ return games.filter(g=>!g.custom && !g.started); }   // games that have kicked off drop out of the ranked list
function simAllThen(done){
  const all=boardGames(), todo=all.filter(g=>!g.S);
  if(!todo.length){ done(); return; } if(bdBusy) return; bdBusy=true;
  let k=0;
  const step=()=>{ $("#bd-info").textContent=`Simulating game ${all.length-todo.length+k+1} of ${all.length}…`;
    setTimeout(()=>{ runSim(todo[k]); k++; if(k<todo.length) step(); else { bdBusy=false; renderRibbon(); done(); } }, 15); };
  step();
}
function boardRows(){ const out=[];
  boardGames().forEach(g=>{ if(!g.S) return;
    const tag=r=>Object.assign(r,{g, mkt: r.kind==="side"? "side" : r.key.startsWith("td:")? "td" : "prop"});
    thursdaySkip(g, dedupePicks([...gameRows(g), ...tdRows(g), ...propRows(g)])).forEach(r=>out.push(tag(r))); });
  return out; }
const bdGameCell = g => `<span class="row" style="display:inline-flex;gap:4px;align-items:center">${badge(g.away)}<span class="small">at</span>${badge(g.home)}</span><div class="small">${esc(g.kickoff.replace(" UK",""))}</div>${typeof gameScore==="function"? gameScore(g) : ""}`;
function renderBoard(){
  if(!$("#bd-table")) return;
  const all=boardGames(), done=all.filter(g=>g.S).length;
  const rows=boardRows(), show=($("#bd-show")||{}).value||"pl", mk=($("#bd-mkt")||{}).value||"all";
  const priced=rows.filter(r=>r.status!=="no price" && (mk==="all"||r.mkt===mk));
  const list=priced.filter(r=> show==="all" || r.status==="pick" || r.status==="lean")
    .sort((a,b)=>(BD_ORDER[a.status]-BD_ORDER[b.status]) || (b.pModel-a.pModel));
  const picks=[]; all.forEach(g=>{ if(g.S) picks.push(...oneBetPerPlayer(rows.filter(r=>r.g===g))); });
  const stake=picks.reduce((a,r)=>a+r.stake,0), nLean=priced.filter(r=>r.status==="lean").length, nCheck=priced.filter(r=>r.status==="check").length;
  $("#bd-info").textContent = done<all.length ? `${done} of ${all.length} games simulated` : `${all.length} games · ${nSims.toLocaleString()} sims each`;
  $("#bd-sum").innerHTML = `<div class="label" style="margin-bottom:8px">${picks.length} pick${picks.length===1?"":"s"} · ${nLean} lean${nLean===1?"":"s"} · ${nCheck} to check · £${stake.toFixed(2)} suggested stake</div>`;
  const head=`<thead><tr><th>Bet</th><th>Game</th><th class="num">Sim</th><th class="num">Market</th><th class="num">Edge</th><th class="num">Take at</th><th>Verdict</th>${typeof rowResult==="function"? "<th>Result</th>" : ""}<th></th></tr></thead>`;
  $("#bd-table").innerHTML = list.length ? head+"<tbody>"+list.map(r=>{
    const ev = r.ev==null? "–" : (r.ev>=0?"+":"")+pct(r.ev,1);
    return `<tr class="${r.status==="pick"?"pkrow":""}"><td><strong>${esc(r.label)}</strong>${(r.inh||0)>=0.25?` <span class="qtag">${Math.round(r.inh*100)}% INHERITED</span>`:""}${r.status==="lean"&&r.why&&r.why.length?`<div class="small">${esc(r.why[0])}</div>`:""}</td>
      <td>${bdGameCell(r.g)}</td><td class="num mono">${pct(r.pModel,1)}</td><td class="num mono">${pct(r.pMkt,1)}</td><td class="num mono">${ev}</td>
      <td class="num mono">${r.takeAt&&r.status!=="check"? `<strong>${r.takeAt.toFixed(2)}</strong> <span class="small">${fracTxt(r.takeAt)}</span>`:"–"}</td>
      <td>${badgeS(r.status)}</td>${typeof rowResult==="function"? "<td>"+resultBadge(rowResult(r))+"</td>" : ""}<td><button class="btn bdopen" type="button" data-i="${r.g.idx}">Open</button></td></tr>`; }).join("")+"</tbody>"
    : `<tbody><tr><td class="sub">${done<all.length? "Simulating…" : show==="pl"? "No picks or leans in this market at the current prices. Switch Show to \"Every priced bet\" to see the rest." : "No priced bets in this market yet. Type prices into a game's boxes below."}</td></tr></tbody>`;
  // highest anytime-TD chances that have no price yet: what to look up in your betting app
  const tdn=rows.filter(r=>r.mkt==="td" && r.status==="no price" && r.pModel>0).sort((a,b)=>b.pModel-a.pModel).slice(0,25);
  $("#bd-td").innerHTML = tdn.length ? `<thead><tr><th>Player</th><th>Game</th><th class="num">Sim</th><th class="num">Fair price</th><th class="num">Worth it at</th>${typeof rowResult==="function"? "<th>Result</th>" : ""}<th></th></tr></thead><tbody>`+
    tdn.map(r=>{ const fair=1/r.pModel, take=(1+RULES.minEVPlayer)/r.pModel;
      return `<tr><td><strong>${esc(r.name)}</strong>${(r.inh||0)>=0.25?` <span class="qtag">${Math.round(r.inh*100)}% INHERITED</span>`:""}</td><td>${bdGameCell(r.g)}</td><td class="num mono">${pct(r.pModel,1)}</td>
        <td class="num mono">${fair.toFixed(2)} <span class="small">${fracNear(fair)}</span></td><td class="num mono"><strong>${take.toFixed(2)}</strong> <span class="small">${fracTxt(take)}</span></td>${typeof rowResult==="function"? "<td>"+resultBadge(rowResult(r))+"</td>" : ""}
        <td><button class="btn bdopen" type="button" data-i="${r.g.idx}">Open</button></td></tr>`; }).join("")+"</tbody>"
    : `<tbody><tr><td class="small">Every listed scorer has a price.</td></tr></tbody>`;
  if(typeof renderScorecard==="function") renderScorecard(rows);
  document.querySelectorAll("#board-card .bdopen").forEach(b=>b.addEventListener("click",()=>{ gi=+b.dataset.i; onGame();
    const t=$("#picksum"); if(t) t.scrollIntoView({behavior:"smooth",block:"start"}); }));
}
function boardIfShown(){ if(location.hash==="#picks") simAllThen(renderBoard); }
// ---------- bet builder (calculator) ----------
// A leg is {type, sel, ou, line}: sel is a team abbreviation, "game", or a player's name.
let bbGame = null;
const PLAYER_T = new Set(["td","rush","rec","recs","pass"]), OU_T = new Set(["total","teamtotal","rush","rec","recs","pass"]);
const legKey = L => [L.type, L.sel, OU_T.has(L.type)? L.ou : "", (L.type==="win"||L.type==="td")? "" : +L.line].join("|");
const hasLeg = (st, L) => !!(st.legs||[]).find(x=>legKey(x)===legKey(L));
function rowLeg(g, r){ const s=r.spec, h=g.home.abbr, a=g.away.abbr;
  switch(s.k){
    case "mlH": return {type:"win", sel:h}; case "mlA": return {type:"win", sel:a};
    case "spH": return {type:"spread", sel:h, line:(-s.line)||0}; case "spA": return {type:"spread", sel:a, line:(+s.line)||0};
    case "ov": return {type:"total", sel:"game", ou:"over", line:s.line}; case "un": return {type:"total", sel:"game", ou:"under", line:s.line};
    case "td": return {type:"td", sel:r.name};
    default: return {type:s.k, sel:r.name, ou:s.side, line:s.line};
  } }
function legName(g, L){
  const nm = L.sel==="game"? `${g.away.abbr} at ${g.home.abbr}` : L.sel===g.home.abbr? g.home.name : L.sel===g.away.abbr? g.away.name : L.sel;
  const sgn = x => (x>0?"+":"")+x, ou = L.ou==="under"? "under" : "over";
  return {win:`${nm} to win`, spread:`${nm} ${sgn(L.line)}`, total:`${ou==="over"?"Over":"Under"} ${L.line} total points`,
    teamtotal:`${nm} ${ou} ${L.line} points`, td:`${nm} anytime TD`, rush:`${nm} ${ou} ${L.line} rushing yds`,
    rec:`${nm} ${ou} ${L.line} receiving yds`, recs:`${nm} ${ou} ${L.line} receptions`, pass:`${nm} ${ou} ${L.line} passing yds`}[L.type];
}
function legMask(g, L){ // 1 where the leg wins in that simulated game (a push counts as not winning)
  const H=g.S.res[g.home.abbr].pts, A=g.S.res[g.away.abbr].pts, n=g.S.n, m=new Uint8Array(n);
  const isH = L.sel===g.home.abbr, ou = x => L.ou==="under"? x<L.line : x>L.line;
  const P = PLAYER_T.has(L.type)? playerArr(g, L.sel) : null; if(PLAYER_T.has(L.type) && !P) return m;
  const arr = P? (L.type==="td"? P.td : L.type==="rush"? P.rush : L.type==="rec"? P.rec : L.type==="recs"? P.recs : P.pass) : null;
  for(let i=0;i<n;i++){ const mg = isH? H[i]-A[i] : A[i]-H[i];
    switch(L.type){
      case "win": m[i] = mg>0; break;
      case "spread": m[i] = mg+L.line>0; break;
      case "total": m[i] = ou(H[i]+A[i]); break;
      case "teamtotal": m[i] = ou(isH? H[i] : A[i]); break;
      case "td": m[i] = arr[i]>=1; break;
      default: m[i] = ou(arr? arr[i] : 0);
    } }
  return m;
}
function exampleFor(g){ // favourite to win + its likeliest RB scorer + its top receiver over a round line
  const fav = g.sim.home_win>=.5? g.home : g.away, favPl = g.players.filter(p=>p.team===fav.abbr);
  const rb = favPl.filter(p=>p.pos==="RB").sort((a,b)=>b.td-a.td)[0];
  const wr = favPl.filter(p=>p.pos==="WR"||p.pos==="TE").sort((a,b)=>b.rec[1]-a.rec[1])[0];
  const out=[{type:"win", sel:fav.abbr}];
  if(rb) out.push({type:"td", sel:rb.name});
  if(wr) out.push({type:"rec", sel:wr.name, ou:"over", line:Math.max(19.5, Math.floor(wr.rec[1]/10)*10-0.5)});
  return out;
}
function refreshLegForm(){
  const g=games[gi], t=$("#lt").value, sel=$("#lsel"), cur=sel.value;
  const teamOpts = `<option value="${esc(g.away.abbr)}">${esc(g.away.name)}</option><option value="${esc(g.home.abbr)}">${esc(g.home.name)}</option>`;
  const pl = g.players.filter(p => t==="pass"? p.passy : t==="td"? p.td>0.01 : t==="rush"? p.rush[2]>0 : (t==="rec"||t==="recs")? p.rec[2]>0 : true)
    .slice().sort((a,b)=>{ const k = p => t==="td"? p.td : t==="rush"? p.rush[1] : t==="rec"? p.rec[1] : t==="recs"? p.recs[1] : t==="pass"? (p.passy? p.passy[1] : 0) : p.td;
      return (k(b)-k(a)) || a.name.localeCompare(b.name); }); // likeliest first
  if(t==="win"||t==="spread"||t==="teamtotal") sel.innerHTML=teamOpts;
  else if(t==="total") sel.innerHTML=`<option value="game">${esc(g.away.abbr)} at ${esc(g.home.abbr)}</option>`;
  else sel.innerHTML = pl.map(p=>`<option value="${esc(p.name)}">${esc(p.name)} (${esc(p.team)})</option>`).join("");
  if(cur && [...sel.options].some(o=>o.value===cur)) sel.value=cur;
  $("#lou-l").hidden = !OU_T.has(t); $("#lline-l").hidden = (t==="win"||t==="td");
  suggestLine();
}
function suggestLine(){ // market line where there is one, otherwise the simulation's median rounded to a half
  const g=games[gi], t=$("#lt").value, v=$("#lsel").value, inp=$("#lline"), half = x => Math.floor(x)+0.5, mk=g.market||{};
  if(t==="spread"){ const s = mk.spread_home!=null? mk.spread_home : Math.round((g.sim.exp_home-g.sim.exp_away)*2)/2;
    let x = v===g.home.abbr? -s : s; if(Number.isInteger(x)) x -= 0.5; inp.value = x.toFixed(1); }
  else if(t==="total") inp.value = mk.total!=null? mk.total : half(g.sim.exp_home+g.sim.exp_away);
  else if(t==="teamtotal") inp.value = half(v===g.home.abbr? g.sim.exp_home : g.sim.exp_away);
  else { const p=g.players.find(p=>p.name===v); if(!p) return;
    const q = t==="rush"?p.rush: t==="rec"?p.rec: t==="recs"?p.recs: t==="pass"?p.passy:null; if(q) inp.value = half(q[1]); }
}
function renderBuilder(){
  const g=games[gi]; if(!g.S) return; const st=pkState(g), legs=st.legs||[];
  $("#exampleflag").hidden = !st.example || !legs.length;
  const masks = legs.map(L=>legMask(g,L)), n = g.S.n, ps = masks.map(m=>m.reduce((a,b)=>a+b,0)/n);
  $("#bb-legs").innerHTML = legs.length ? legs.map((L,i)=>`<div class="leg"><span>${esc(legName(g,L))}</span><span class="p">${pct(ps[i],1)} · ${dec2(fair(ps[i]))}</span><button class="x" type="button" data-i="${i}" aria-label="Remove leg">×</button></div>`).join("")
    : `<p class="sub">No legs yet. Pick a market above and add it, or tick bets under "How each bet was judged".</p>`;
  $("#bb-legs").querySelectorAll(".x").forEach(b=>b.addEventListener("click",()=>{ st.legs.splice(+b.dataset.i,1); st.example=false; renderPicks(); }));
  $("#bbclear").hidden = !legs.length;
  if(!legs.length){ $("#bb-res").innerHTML=""; $("#bb-verdict").innerHTML=""; return; }
  let j=0; for(let i=0;i<n;i++){ let ok=1; for(const m of masks){ if(!m[i]){ ok=0; break; } } j+=ok; }
  const pj=j/n, pind=ps.reduce((a,p)=>a*p,1), corr = pind>0? pj/pind-1 : 0, take = pj>0? (1+RULES.minEV)/pj : Infinity;
  $("#bb-res").innerHTML = `
    <div class="stat"><div class="label">Lands in</div><div class="v">${pct(pj,1)}</div><div class="small">${j.toLocaleString()} of ${n.toLocaleString()} sims</div></div>
    <div class="stat"><div class="label">Fair price</div><div class="v pitch">${dec2(fair(pj))}</div><div class="small">about ${fracNear(fair(pj))}</div></div>
    <div class="stat"><div class="label">Take at or better</div><div class="v">${dec2(take)}</div><div class="small">${isFinite(take)? fracTxt(take)+" · +5% on the fair price" : "never lands"}</div></div>
    <div class="stat"><div class="label">If legs were independent</div><div class="v">${dec2(fair(pind))}</div><div class="small">${legs.length>1 ? (corr>=0? `legs help each other: ${pct(corr,0)} more likely together` : `legs work against each other: ${pct(-corr,0)} less likely together`) : "single leg"}</div></div>`;
  const bo = toDec($("#bbprice").value);
  if(bo && pj>0){ const ev = pj*bo-1, cls = ev>=RULES.minEV?"good":ev>-0.02?"meh":"bad";
    const txt = ev>=RULES.minEV ? `Worth taking: about ${Math.round(ev*100)}p profit expected per £1 at ${bo.toFixed(2)} (${fracTxt(bo-1e-9)}).`
      : ev>-0.02 ? `Roughly fair at ${bo.toFixed(2)}. No clear edge: you want ${dec2(take)} or bigger.`
      : `Poor value: ${bo.toFixed(2)} is short of the fair ${dec2(fair(pj))} (expected to lose about ${Math.round(-ev*100)}p per £1). You want ${dec2(take)} or bigger.`;
    $("#bb-verdict").innerHTML = `<div class="verdict ${cls}">${txt}</div>`;
  } else $("#bb-verdict").innerHTML = "";
}
(function wirePicks(){ if(!$("#v-picks")) return;
  $("#bd-show").addEventListener("change",renderBoard); $("#bd-mkt").addEventListener("change",renderBoard);
  $("#bd-rerun").addEventListener("click",()=>{ if(bdBusy) return; if(typeof onRerunAll==="function") onRerunAll(); boardGames().forEach(g=>{ g.S=null; g.sim=null; }); simAllThen(()=>{ const g=games[gi]; if(!g.S) runSim(g); renderAll(); }); });
  window.addEventListener("hashchange",boardIfShown); setTimeout(boardIfShown, 60);
  $("#bank").addEventListener("change",renderPicks);
  $("#lt").addEventListener("change",refreshLegForm); $("#lsel").addEventListener("change",suggestLine);
  $("#bbprice").addEventListener("input",renderBuilder);
  $("#bbclear").addEventListener("click",()=>{ const st=pkState(games[gi]); st.legs=[]; st.example=false; renderPicks(); });
  $("#addleg").addEventListener("click",()=>{ const g=games[gi], st=pkState(g), t=$("#lt").value;
    const L={type:t, sel:$("#lsel").value, ou:$("#lou").value, line:parseFloat($("#lline").value)||0};
    if(!L.sel) return; if(t==="win"||t==="td") delete L.line; if(!OU_T.has(t)) delete L.ou;
    if(st.example){ st.legs=[]; st.example=false; } if(!hasLeg(st,L)) st.legs.push(L); renderPicks(); }); $("#minprob").addEventListener("change",renderPicks); $("#cknum").addEventListener("change",renderPicks);
  $("#ap-add").addEventListener("click",()=>{ const g=games[gi], st=pkState(g), ln=parseFloat($("#ap-ln").value);
    if(!isFinite(ln)) return; st.props.push({name:$("#ap-pl").value, stat:$("#ap-st").value, line:ln, ov:$("#ap-ov").value, un:$("#ap-un").value}); renderPicks(); });
})();
