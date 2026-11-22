/* Edge Engine simulator, JavaScript port of edge/sim.py + edge/replay.py.
   Runs in the browser (Sim Lab) or Node (tests). Same model, same constants; only the RNG differs. */
(function (root) {
  "use strict";

  // ---------- RNG (mulberry32) + samplers ----------
  function rng(seed) {
    let a = seed >>> 0;
    const u = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    let spare = null;
    const normal = (m, s) => { if (spare !== null) { const z = spare; spare = null; return m + s * z; }
      let x, y, r; do { x = 2 * u() - 1; y = 2 * u() - 1; r = x * x + y * y; } while (r >= 1 || r === 0);
      const f = Math.sqrt(-2 * Math.log(r) / r); spare = y * f; return m + s * x * f; };
    const gamma = (k) => { // Marsaglia-Tsang
      if (k < 1) { const g = gamma(k + 1); return g * Math.pow(u() || 1e-12, 1 / k); }
      const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
      for (;;) { let x, v; do { x = normal(0, 1); v = 1 + c * x; } while (v <= 0);
        v = v * v * v; const uu = u(); if (uu < 1 - 0.0331 * x * x * x * x) return d * v;
        if (Math.log(uu) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v; } };
    const poisson = (lam) => { if (lam <= 0) return 0; if (lam > 30) return Math.max(0, Math.round(normal(lam, Math.sqrt(lam))));
      const L = Math.exp(-lam); let k = 0, p = 1; do { k++; p *= u(); } while (p > L); return k - 1; };
    const binom = (n, p) => { let c = 0; for (let i = 0; i < n; i++) if (u() < p) c++; return c; };
    const pick = (cum) => { const x = u() * cum[cum.length - 1]; let i = 0; while (cum[i] < x) i++; return i; };
    return { u, normal, gamma, poisson, binom, pick };
  }
  const clip = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const cumsum = (a) => { const o = new Float64Array(a.length); let s = 0; a.forEach((v, i) => { s += v; o[i] = s; }); return o; };

  // ---------- model pieces ----------
  function rate(M, off, def, k, mult) {
    const lg = M.lg[k];
    return lg * (M.teams[off].off[k] / lg) * (M.teams[def].def[k] / lg) * (mult || 1);
  }
  function pace(M, h, a) {
    const T = M.teams;
    return (T[h].off.drives + T[a].off.drives + T[h].def.drives + T[a].def.drives) / 4;
  }
  function roster(M, t, opt) { // available players for this game (+ the starting QB if he has no carries/targets)
    const T = M.teams[t], L = opt && opt.lineups && opt.lineups[t];
    const pl = (L ? L.players : T.players).slice(), qb = L ? L.qb : T.qb;
    if (qb && !pl.some(p => p.id === qb.id))
      pl.push({ id: qb.id, name: qb.name, pos: "QB", carry: 0, i10: 0, rush: 0, tgt: 0, rz: 0, rec: 0, cr: 0.65, pocket: true });
    pl.qb = qb; return pl;
  }
  const GROUP = { RB: "RB", FB: "RB", HB: "RB", WR: "WR", TE: "TE", QB: "QB" };
  function tilt(M, pl, opp) { // defence vs position: shift shares toward the positions this defence leaks to
    const f = M.teams[opp] && M.teams[opp].dvp; if (!f || !pl.length) return pl;
    const out = pl.map(p => Object.assign({}, p)); out.qb = pl.qb;
    const grp = out.map(p => GROUP[p.pos] || "OTHER");
    const go = (cols, table) => { const m = grp.map(g => (table && table[g] !== undefined) ? table[g] : 1);
      for (const c of cols) { const tot = out.reduce((x, p) => x + p[c], 0); if (tot <= 0) continue;
        const nv = out.map((p, j) => p[c] * m[j]), ns = nv.reduce((x, y) => x + y, 0); out.forEach((p, j) => { p[c] = nv[j] * tot / ns; }); } };
    go(["rec", "tgt"], f.rec); go(["rz"], f.ptd); go(["i10"], f.rtd);
    return out;
  }
  function weatherMult(K, w) {
    if (!w || w.roof === "dome" || w.roof === "closed") return [1, 1, 1];
    const x = Math.max(0, Math.min(+w.wind || 0, 25) - 10), cold = w.temp !== null && w.temp !== undefined && w.temp !== "" && +w.temp <= 32;
    // rain: outdoor games in rain 2024-26 averaged ~10% fewer yards per pass attempt (25 games; heavy rain worse)
    const rain = w.rain === "heavy" ? (K.RAIN_HEAVY_PASS || 0.8) : w.rain === "rain" ? (K.RAIN_PASS || 0.9) : 1;
    return [(1 + K.WIND_PASS * x) * rain, 1 + K.WIND_TD * x, (1 + K.WIND_FG * x) * (cold ? K.COLD_FG : 1)];
  }
  function tdShares(pl, K) {
    const rawR = pl.map(p => 0.55 * p.i10 + 0.45 * p.carry), rawP = pl.map(p => 0.5 * p.rz + 0.5 * p.tgt);
    const fl = (raw) => { const f = raw.map(x => Math.pow(x, K.TD_FLATTEN)), s = f.reduce((a, b) => a + b, 0) || 1e-9,
      tot = Math.min(0.97, raw.reduce((a, b) => a + b, 0)); const sh = f.map(x => x / s * tot);
      sh.push(Math.max(1e-3, 1 - sh.reduce((a, b) => a + b, 0))); return cumsum(sh); };
    return { r: fl(rawR), p: fl(rawP) };
  }
  function scoringRates(M, h, a, opt, Dmean) { // Dmean = {team: mean drives}
    const K = M.k, out = {}, [wp, wt, wf] = weatherMult(K, opt.weather);
    const hfa = opt.neutral ? 1 : K.HFA * (1 + (K.REST_K || 0) * clip(+opt.restDiff || 0, -7, 7));
    for (const [t, o, mult] of [[h, a, hfa], [a, h, 1 / hfa]]) {
      let ptd = rate(M, t, o, "td", mult) * wt, pfg = rate(M, t, o, "fg", mult) * wf, ky = 1;
      const dm = typeof Dmean === "number" ? Dmean : Dmean[t];
      if (opt.anchor) {
        const [sp, tot0] = opt.anchor, tot = tot0 + (K.TOTAL_MEAN_OFFSET == null ? 0.5 : K.TOTAL_MEAN_OFFSET), /* betting totals sit at the middle outcome, and games are lopsided (the odd shootout), so the average sits ~0.5 pts above the line: tuned so overs land ~49-50% as in 2022-26 */ target = t === h ? (tot + sp) / 2 : (tot - sp) / 2;
        const exp = dm * (ptd * (6 + K.PAT) + pfg * 3) + 7 * K.NONOFF;
        const k = Math.max(target - 7 * K.NONOFF, 1) / Math.max(exp - 7 * K.NONOFF, 1);
        ptd *= k; pfg *= k; ky = Math.pow(clip(k, 0.4, 2), K.YARD_ANCHOR == null ? 0.7 : K.YARD_ANCHOR);
      }
      out[t] = { ptd: Math.min(ptd, 0.6), pfg: Math.min(pfg, 0.35),
                 pass: rate(M, t, o, "pass_ypd") * wp * ky * (((((opt.lineups || {})[t] || {}).qb || {}).changed) ? (K.BACKUP_QB_PASS || 0.85) : 1), /* backup QB starting: passing yards trimmed (week 9 backups averaged ~25% under) */ rush: rate(M, t, o, "rush_ypd") * ky };
    }
    return out;
  }

  // ---------- full simulation ----------
  function simulate(M, h, a, opt) {
    opt = opt || {}; const n = opt.n || 10000, R = rng(opt.seed || 1), K = M.k;
    const pc = pace(M, h, a);
    // coin toss + halves: drives alternate in each half; the team receiving a half gets its odd drive
    const Dh = new Int16Array(n), Da = new Int16Array(n), homeFirst = new Uint8Array(n);
    let sh_ = 0, sa_ = 0;
    for (let i = 0; i < n; i++) {
      const tot = clip(Math.round(R.normal(2 * pc, 1.3)), 16, 30), h1 = clip(Math.round(tot / 2 + R.normal(0, 0.8)), 7, 16), h2 = tot - h1;
      const r1 = Math.floor((h1 + 1) / 2) + Math.floor(h2 / 2), r2 = Math.floor(h1 / 2) + Math.floor((h2 + 1) / 2);
      homeFirst[i] = R.u() < 0.5 ? 1 : 0; Dh[i] = homeFirst[i] ? r1 : r2; Da[i] = homeFirst[i] ? r2 : r1; sh_ += Dh[i]; sa_ += Da[i];
    }
    const rates = scoringRates(M, h, a, opt, { [h]: sh_ / n, [a]: sa_ / n });
    // Game script: drives are played in order, and a team that is ahead scores a little less on its next drive
    // (runs the clock, plays safe) while a team behind scores a little more, more so after half-time. Real NFL
    // scores are tighter than independent drives would give (margin spread 12.3 vs 13.7 points), and this is what
    // stops the sim pulling favourites towards 50/50. Rates are re-scaled so each team's average points still
    // match the betting line.
    const GS = K.GAME_SCRIPT == null ? 0.045 : K.GAME_SCRIPT;   // v3.2: margin spread 12.3 = real games (2022-26); favourites within 0.5 pt of the market
    const playGames = (rs, i0, i1, store) => {
      let sum = { [h]: 0, [a]: 0 };
      for (let i = i0; i < i1; i++) {
        const tot = Dh[i] + Da[i], first = homeFirst[i] ? h : a, second = first === h ? a : h;
        const h1 = Math.round(tot / 2);   // drives before half-time (both teams)
        const sc = { [h]: 0, [a]: 0 }, nt = { [h]: 0, [a]: 0 }, nf = { [h]: 0, [a]: 0 }, left = { [h]: Dh[i], [a]: Da[i] };
        for (let d = 0; d < tot; d++) {
          const half2 = d >= h1, off = (half2 ? ((d - h1) % 2 === 0 ? second : first) : (d % 2 === 0 ? first : second));
          const t = left[off] > 0 ? off : (off === h ? a : h); left[t]--;
          const lead = sc[t] - sc[t === h ? a : h], m = clip(1 - GS * (half2 ? 1 : 0.5) * lead / 7, 0.55, 1.6);
          const x = R.u(), pt = rs[t].ptd * m, pf = rs[t].pfg * m;
          if (x < pt) { nt[t]++; sc[t] += 7; } else if (x < pt + pf) { nf[t]++; sc[t] += 3; }
        }
        for (const t of [h, a]) {
          const pat = R.binom(nt[t], K.PAT), no = R.poisson(K.NONOFF), p = 6 * nt[t] + pat + 3 * nf[t] + 7 * no;
          sum[t] += p; if (store) { store[t].td[i] = nt[t]; store[t].fg[i] = nf[t]; store[t].pts[i] = p; }
        }
      }
      return sum;
    };
    if (GS > 0) {   // pilot run, then re-scale scoring rates so average points match the intended (anchored) means
      const intended = t => (t === h ? sh_ : sa_) / n * (rates[t].ptd * (6 + K.PAT) + 3 * rates[t].pfg) + 7 * K.NONOFF;
      const np = Math.min(n, 4000), target = { [h]: intended(h), [a]: intended(a) };   // fix the targets first: they must not move as rates change
      for (let it = 0; it < 3; it++) {
        const got = playGames(rates, 0, np, null);
        for (const t of [h, a]) { const f = clip((target[t] - 7 * K.NONOFF) / Math.max(got[t] / np - 7 * K.NONOFF, 1), 0.7, 1.4); rates[t].ptd *= f; rates[t].pfg *= f; }
      }
    }
    const res = { [h]: { pts: new Int16Array(n), td: new Int16Array(n), fg: new Int16Array(n), D: Dh }, [a]: { pts: new Int16Array(n), td: new Int16Array(n), fg: new Int16Array(n), D: Da } };
    playGames(rates, 0, n, res);
    // overtime (2025+ regular season): toss winner receives, both teams get a possession, then sudden death, else a tie
    const ot = new Uint8Array(n), H = res[h], A = res[a];
    const drive = (r, needTd) => { const x = R.u(); if (needTd) return x < Math.min(r.ptd * (K.OT_TD_BOOST || 1.25), 0.7) ? "TD" : "none";
      return x < r.ptd ? "TD" : x < r.ptd + r.pfg ? "FG" : "none"; };
    for (let i = 0; i < n; i++) {
      if (H.pts[i] !== A.pts[i]) continue;
      ot[i] = 1; const order = R.u() < 0.5 ? [h, a] : [a, h], add = { [h]: [0, 0, 0], [a]: [0, 0, 0] };
      const r1 = drive(rates[order[0]], false), r2 = drive(rates[order[1]], r1 === "TD");
      for (const [t, r] of [[order[0], r1], [order[1], r2]]) { if (r === "TD") { add[t][0] += 7; add[t][1]++; } else if (r === "FG") { add[t][0] += 3; add[t][2]++; } }
      let k2 = 0;
      while (add[h][0] === add[a][0] && k2 < 4) { const t = order[k2 % 2], r = drive(rates[t], false);
        if (r === "TD") { add[t][0] += 6; add[t][1]++; } else if (r === "FG") { add[t][0] += 3; add[t][2]++; } k2++; }
      for (const t of [h, a]) { res[t].pts[i] += add[t][0]; res[t].td[i] += add[t][1]; res[t].fg[i] += add[t][2]; }
    }
    for (const t of [h, a]) {
      const r = rates[t], s = res[t], D = s.D, py = new Float32Array(n), ry = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const succ = (s.td[i] + 0.6 * s.fg[i]) - (r.ptd + 0.6 * r.pfg) * D[i];
        const f = clip(1 + 0.11 * succ + R.normal(0, K.YARD_NOISE2 || 0.30) /* was 0.18: passing-yard ranges were too narrow */, 0.3, 2.2);
        py[i] = r.pass * D[i] * f; ry[i] = r.rush * D[i] * f;
      }
      s.py = py; s.ry = ry;
    }
    for (const [t, o] of [[h, a], [a, h]]) { // game script
      const s = res[t], op = res[o].pts;
      for (let i = 0; i < n; i++) {
        const tot = s.py[i] + s.ry[i], shift = clip(0.025 * (s.pts[i] - op[i]) / 7, -0.12, 0.12);
        const ps = s.py[i] / Math.max(tot, 1) - shift; s.py[i] = tot * ps; s.ry[i] = tot * (1 - ps);
      }
    }
    const players = {};
    for (const [t, o] of [[h, a], [a, h]]) {
      const T = M.teams[t], s = res[t], pl = tilt(M, roster(M, t, opt), o), k = pl.length, sh = tdShares(pl, K);
      // Player volume is built from opportunities: targets -> catches -> yards per catch, and carries -> yards per carry.
      // A player with no catch gets no receiving yards. Each sim also draws a role multiplier per player (snaps, game
      // script, early exits), then all players' yards are scaled so they add up to the team's yards in that sim.
      const ROLE = K.ROLE_SHAPE || 8, AP = K.CATCH_SHAPE || 0.75, AR = K.CARRY_SHAPE || 0.3, YPC = 4.4; // tuned on 2026 wks 3-8 range coverage
      const sumOf = (col) => pl.reduce((x, p) => x + Math.max(p[col] || 0, 0), 0);
      const oth = { carry: Math.max(0.02, 1 - sumOf("carry")), rush: Math.max(0.02, 1 - sumOf("rush")),
                    tgt: Math.max(0.03, 1 - sumOf("tgt")), rec: Math.max(0.03, 1 - sumOf("rec")), cr: 0.65 };
      // Targets: blend each pass catcher's target share with what his snap share implies for his position,
      // so a regular on the field (e.g. a blocking tight end) keeps a fair chance of being thrown to.
      const SW = K.SNAP_W == null ? 0.5 : K.SNAP_W;   // tuned on 2026 wks 3-8
      if (SW > 0) {
        if (!M._snapRatio) { const acc = {}; for (const tm of Object.values(M.teams)) for (const p of tm.players || []) {
            const sn = (p.log || []).map(g => g.sn).filter(v => v != null); if (!sn.length || !(p.tgt > 0)) continue;
            const a = acc[p.pos] || (acc[p.pos] = [0, 0]); a[0] += p.tgt; a[1] += sn.reduce((x, y) => x + y, 0) / sn.length / 100; }
          M._snapRatio = Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, v[0] / Math.max(v[1], 1e-6)])); }
        for (const p of pl) { const sn = (p.log || []).map(g => g.sn).filter(v => v != null), r = M._snapRatio[p.pos];
          if (!sn.length || !r || !["WR", "TE", "RB"].includes(p.pos)) { p._tgt = p.tgt; continue; }
          p._tgt = (1 - SW) * (p.tgt || 0) + SW * r * (sn.reduce((x, y) => x + y, 0) / sn.length / 100); }
        const t0 = pl.reduce((a, p) => a + (p.tgt || 0), 0), t1 = pl.reduce((a, p) => a + (p._tgt || 0), 0) || 1;
        for (const p of pl) p._tgt = (p._tgt || 0) * t0 / t1;   // same team total, re-shared
      } else for (const p of pl) p._tgt = p.tgt;
      const ALL = pl.concat([oth]);
      const ypc = ALL.map(p => p.carry > 0.002 ? clip(YPC * (p.rush || 0) / p.carry, 1.5, 9) : 0);
      const ypr = ALL.map(p => (p.tgt > 0.002 && (p.cr || 0) > 0.05) ? clip((p.rec || 0) / (p.tgt * p.cr), 0.15, 3.5) : 0);
      const RS = K.ROLE_SMALL == null ? 1.0 : K.ROLE_SMALL;   // role swing grows as the role shrinks
      const roleShape = ALL.map(p => { const sh = (p._tgt ?? p.tgt ?? 0) + (p.carry || 0); return ROLE * clip(Math.pow(sh / 0.2, RS), 0.25, 2.5); });
      let pyMean = 0; for (let i = 0; i < n; i++) pyMean += s.py[i]; pyMean /= n;
      const P = pl.map(p => ({ p, rush: new Float32Array(n), rec: new Float32Array(n), recs: new Int16Array(n), td: new Int8Array(n), pass: null, ptd: null }));
      const qbi = pl.qb ? pl.findIndex(p => p.id === pl.qb.id) : -1;
      if (qbi >= 0) { P[qbi].pass = s.py; P[qbi].ptd = new Int8Array(n); }
      const rawR = new Float64Array(k + 1), rawP = new Float64Array(k + 1), cat = new Int32Array(k + 1);
      for (let i = 0; i < n; i++) {
        const scale = s.py[i] / pyMean, carries = s.ry[i] / YPC, targets = T.tgtPg * scale;
        let sR = 0, sP = 0;
        for (let j = 0; j <= k; j++) {
          const p = ALL[j], m = j < k ? R.gamma(roleShape[j]) / roleShape[j] : 1;
          const nc = p.carry > 0 ? R.poisson(p.carry * carries * m) : 0;
          rawR[j] = nc > 0 && ypc[j] > 0 ? R.gamma(AR * nc) / AR * ypc[j] : 0; sR += rawR[j];
          const tg = p._tgt ?? p.tgt, nt = tg > 0 ? R.poisson(tg * targets * m) : 0, c = nt > 0 ? R.binom(nt, clip(p.cr || 0.65, 0.05, 0.95)) : 0;
          cat[j] = c; rawP[j] = c > 0 && ypr[j] > 0 ? R.gamma(AP * c) / AP * ypr[j] : 0; sP += rawP[j];
        }
        for (let j = 0; j < k; j++) {
          P[j].rush[i] = sR > 0 ? rawR[j] / sR * s.ry[i] : 0;
          P[j].rec[i] = sP > 0 ? rawP[j] / sP * s.py[i] : 0;
          P[j].recs[i] = cat[j];
        }
        const rtd = R.binom(s.td[i], T.rtdFrac), ptdn = s.td[i] - rtd;
        for (let x = 0; x < rtd; x++) { const j = R.pick(sh.r); if (j < k) P[j].td[i]++; }
        for (let x = 0; x < ptdn; x++) { const j = R.pick(sh.p); if (j < k) P[j].td[i]++; }
        if (qbi >= 0) P[qbi].ptd[i] = ptdn;
      }
      players[t] = P;
    }
    let otc = 0; for (let i = 0; i < n; i++) otc += ot[i];
    return { home: h, away: a, n, res, players, rates, ot, otRate: otc / n };
  }

  // ---------- summaries ----------
  function quant(arr, qs) { const s = Float32Array.from(arr).sort(); return qs.map(q => s[Math.min(s.length - 1, Math.floor(q * s.length))]); }
  function summarise(M, S, marketLine) {
    const h = S.res[S.home], a = S.res[S.away], n = S.n;
    let hw = 0, tie = 0, sh = 0, sa = 0; const margin = new Int16Array(n), total = new Int16Array(n);
    const mh = new Array(81).fill(0), th = new Array(101).fill(0), scores = new Map();
    for (let i = 0; i < n; i++) {
      const m = h.pts[i] - a.pts[i]; margin[i] = m; total[i] = h.pts[i] + a.pts[i];
      if (m > 0) hw++; else if (m === 0) tie++; sh += h.pts[i]; sa += a.pts[i];
      mh[clip(m, -40, 40) + 40]++; th[clip(total[i], 0, 100)]++;
      const key = a.pts[i] + "-" + h.pts[i]; scores.set(key, (scores.get(key) || 0) + 1);
    }
    const top = [...scores.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, c]) => { const [aw, hm] = k.split("-"); return { away: +aw, home: +hm, p: c / n }; });
    const Q = [0.1, 0.5, 0.9];
    const out = {
      home_win: (hw + tie / 2) / n, away_win: (n - hw - tie + tie / 2) / n, exp_home: sh / n, exp_away: sa / n,
      home_pts: quant(h.pts, Q), away_pts: quant(a.pts, Q), total: quant(total, Q), margin: quant(margin, Q),
      margin_hist: mh, total_hist: th, top_scores: top, ot_rate: S.otRate || 0, tie_rate: tie / n,
      home_pass: quant(h.py, Q), home_rush: quant(h.ry, Q), away_pass: quant(a.py, Q), away_rush: quant(a.ry, Q),
      players: [],
    };
    if (marketLine) {
      let cov = 0, ov = 0; for (let i = 0; i < n; i++) { if (margin[i] > marketLine[0]) cov++; if (total[i] > marketLine[1]) ov++; }
      out.cover = cov / n; out.over = ov / n;
    }
    for (const t of [S.home, S.away]) for (const P of S.players[t]) {
      let tdc = 0; for (let i = 0; i < n; i++) if (P.td[i] >= 1) tdc++;
      out.players.push({ id: P.p.id, name: P.p.name, pos: P.p.pos, team: t, td: tdc / n, q: !!P.p.q,
        rush: quant(P.rush, Q), rec: quant(P.rec, Q), recs: quant(P.recs, Q), passy: P.pass ? quant(P.pass, Q) : null });
    }
    out.players.sort((x, y) => y.td - x.td);
    return out;
  }

  // ---------- one game, drive by drive and play by play ----------
  // Chance a drive ends in a TD / FG from a given spot (yards from own goal line), for an average offence.
  const tdFrom = y => y >= 98 ? 0.78 : y >= 95 ? 0.7 : clip(0.08 + 0.0058 * y, 0.05, 0.66);
  const fgFrom = y => y < 45 ? 0.02 : y < 75 ? 0.02 + 0.011 * (y - 45) : clip(0.35 - 0.004 * (y - 75), 0.2, 0.35);
  function replay(M, h, a, opt) {
    opt = opt || {}; const R = rng(opt.seed || 7), K = M.k, pc = pace(M, h, a);
    const rates = scoringRates(M, h, a, opt, pc);
    const people = {}, nameOf = t => M.teams[t].name.split(" ").slice(-1)[0];
    for (const [t, o] of [[h, a], [a, h]]) { const pl = tilt(M, roster(M, t, opt), o), sh = tdShares(pl, K);
      const nm = pl.map(p => p.name), other = "a teammate";
      const cr = cumsum(pl.map(p => Math.max(p.carry, 0)).concat([0.02])), ct = cumsum(pl.map(p => Math.max(p.tgt, 0)).concat([0.03]));
      people[t] = { names: nm.concat([other]), sh, frac: M.teams[t].rtdFrac, qb: pl.qb ? pl.qb.name : "the QB",
        rusher: () => nm.concat([other])[R.pick(cr)], target: () => nm.concat([other])[R.pick(ct)] }; }
    const tossWin = R.u() < 0.5 ? h : a, recv1 = tossWin === h ? a : h, recv2 = tossWin;
    const tot = clip(Math.round(R.normal(2 * pc, 1.3)), 18, 28), h1 = clip(Math.round(tot / 2 + R.normal(0, 0.8)), 8, 15), h2 = tot - h1;
    const score = { [h]: 0, [a]: 0 }, drives = [];
    const choice = (arr, w) => { const c = cumsum(w); return arr[R.pick(c)]; };
    const spot = (t, y) => y === 50 ? "the 50" : y < 50 ? `${t} ${y}` : `${t === h ? a : h} ${100 - y}`;
    let start = K.TOUCHBACK;
    // play-by-play for one drive whose result is already drawn; returns plays + where it ended
    const genPlays = (t, start, res, scorer, tdRush) => {
      const P = people[t], out = [];
      const target = res === "TD" ? 100 : (res === "FG" || res === "Missed FG") ? clip(Math.round(R.normal(72, 8)), 58, 90)
        : clip(Math.round(start + R.gamma(2) * 12), start, 85);
      let pos = start, down = 1, togo = 10, guard = 0;
      const push = (o) => out.push(Object.assign({ down, togo, yl: pos, team: t }, o));
      const maxSnaps = (res === "FG" || res === "Missed FG") ? 40 : 26;
      while (guard++ < maxSnaps) {
        const finishing = res !== "TD" && pos >= target - 2;
        if (res === "Turnover" && (finishing || guard > 12)) {
          const pass = R.u() < 0.55, who = pass ? P.target() : P.rusher();
          push(Object.assign({ kind: "turnover", gain: 0, text: pass ? `${P.qb} pass intended for ${who} is intercepted` : `${who} fumbles, recovered by the defence` }, pass ? { passer: P.qb, to: who } : { by: who })); break;
        }
        if (down === 4 && (finishing || res !== "TD")) {
          if (res === "Punt") { push({ kind: "punt", gain: 0, text: "Punt" }); break; }
          if ((res === "FG" || res === "Missed FG") && (finishing || guard > 36)) { if (100 - pos + 17 > 75) { const g = 42 - pos, tg = P.target(); push({ kind: "pass", gain: g, text: `${P.qb} pass to ${tg} for ${g}`, passer: P.qb, to: tg }); pos += g; down = 1; togo = 10; } const d = 100 - pos + 17; push({ kind: "fg", gain: 0, dist: d, text: `${d}-yard field goal attempt` }); break; } // only kick once in range; otherwise go for it
          if (res === "Downs" && finishing) { const g = Math.max(0, togo - 1 - Math.floor(R.u() * 3)); push({ kind: "downs", gain: g, text: `4th & ${togo}: ${P.qb} pass falls incomplete, turnover on downs`, passer: P.qb }); pos += g; break; }
        }
        // a normal snap
        const passP = togo >= 8 ? 0.68 : togo <= 2 ? 0.38 : 0.58, x = R.u();
        let kind, gain, text, meta = {};
        if (x < passP) {
          const y = R.u();
          if (y < 0.065) { gain = -Math.round(4 + R.u() * 6); kind = "sack"; text = `${P.qb} sacked for a loss of ${-gain}`; meta = { passer: P.qb }; }
          else if (y < 0.065 + 0.30) { const tg = P.target(); gain = 0; kind = "inc"; text = `${P.qb} pass incomplete to ${tg}`; meta = { passer: P.qb, to: tg }; }
          else { const rec = P.target(); gain = Math.max(1, Math.round(R.u() < 0.1 ? 20 + R.gamma(2) * 9 : R.normal(10.5, 6.5))); kind = "pass"; text = `${P.qb} pass to ${rec} for ${gain}`; meta = { passer: P.qb, to: rec }; }
        } else {
          const ru = P.rusher(); gain = Math.round(R.u() < 0.06 ? 12 + R.gamma(2) * 7 : R.normal(4.6, 4)); gain = Math.max(gain, -4);
          kind = "run"; text = gain >= 0 ? `${ru} run for ${gain}` : `${ru} run for a loss of ${-gain}`; meta = { by: ru };
        }
        if (down === 4) { if (kind === "sack") meta = { by: P.qb }; gain = Math.max(gain, togo); kind = kind === "sack" || kind === "inc" ? (kind === "sack" ? "run" : "pass") : kind; text = `4th & ${togo}: ` + text.replace(/for -?\d+$/, `for ${gain}`).replace(/incomplete to (.+)$/, `to $1 for ${gain}`).replace(/sacked for a loss of \d+/, `scrambles for ${gain}`); }
        if (res === "TD" && pos + gain >= 100) {
          const d = 100 - pos;
          push(Object.assign({ kind: "td", gain: d, text: tdRush ? `${scorer} ${d}-yard TD run` : `${P.qb} ${d}-yard TD pass to ${scorer}` }, tdRush ? { by: scorer } : { passer: P.qb, to: scorer })); pos = 100; break;
        }
        if (res === "TD" && guard >= 24) { const d = 100 - pos; push(Object.assign({ kind: "td", gain: d, text: tdRush ? `${scorer} ${d}-yard TD run` : `${P.qb} ${d}-yard TD pass to ${scorer}` }, tdRush ? { by: scorer } : { passer: P.qb, to: scorer })); pos = 100; break; }
        if (res !== "TD" && pos + gain > target) { gain = Math.max(0, target - pos);
          if (gain === 0 && kind !== "sack") { const tg = P.target(); kind = "inc"; text = `${P.qb} pass incomplete to ${tg}`; meta = { passer: P.qb, to: tg }; }
          else text = text.replace(/for \d+$/, `for ${gain}`); }
        if (pos + gain >= 100) gain = 99 - pos;
        if (pos + gain < 1) gain = 1 - pos;
        push(Object.assign({ kind, gain, text }, meta)); pos += gain;
        if (gain >= togo) { down = 1; togo = Math.min(10, 100 - pos); } else { down += 1; togo -= gain; }
      }
      if ((res === "FG" || res === "Missed FG") && !(out.length && out[out.length - 1].kind === "fg")) { if (100 - pos + 17 > 75) { const g = 42 - pos, tg = P.target(); push({ kind: "pass", gain: g, text: `${P.qb} pass to ${tg} for ${g}`, passer: P.qb, to: tg }); pos += g; down = 1; togo = 10; } const d = 100 - pos + 17; push({ kind: "fg", gain: 0, dist: d, text: `${d}-yard field goal attempt` }); }
      return { plays: out, end: pos };
    };
    const play = (t, q, note, mode) => { // mode: undefined | "needTD" | "OT"
      const r = rates[t], x = R.u();
      let res = mode === "needTD" ? (x < Math.min(r.ptd * (K.OT_TD_BOOST || 1.25), 0.7) ? "TD" : "Downs")
        : x < r.ptd ? "TD" : x < r.ptd + r.pfg ? "FG" : choice(["Punt", "Turnover", "Downs"], [0.66, 0.22, 0.12]);
      let text = "", scorer = null, pts = 0, tdRush = false; const P = people[t];
      if (res === "TD") {
        if (R.u() < P.frac) { scorer = P.names[R.pick(P.sh.r)]; tdRush = true; text = `${scorer} rushing TD`; }
        else { scorer = P.names[R.pick(P.sh.p)]; text = `${scorer} TD catch from ${P.qb}`; }
      }
      const G = genPlays(t, start, res, scorer, tdRush), end = G.end;
      if (res === "TD") pts = mode === "OT" && q === 6 ? 6 : 6 + (R.u() < K.PAT ? 1 : 0);
      else if (res === "FG") {
        const dist = 100 - end + 17, make = dist < 40 ? 0.97 : dist < 50 ? 0.88 : dist < 56 ? 0.72 : dist < 60 ? 0.55 : 0.3; // attempts never exceed 75 yards
        if (R.u() < make) { pts = 3; text = `${dist}-yard field goal good`; } else { res = "Missed FG"; text = `${dist}-yard field goal missed`; }
        const last = G.plays[G.plays.length - 1]; if (last && last.kind === "fg") last.text = text;
      } else if (res === "Punt") text = "Punt";
      else if (res === "Turnover") { const last = G.plays[G.plays.length - 1]; text = last && /intercept/.test(last.text) ? "Interception" : "Fumble lost"; }
      else text = "Turnover on downs";
      score[t] += pts;
      drives.push({ i: drives.length, q: Math.min(q, 5), team: t, start, end, yards: end - start, plays: G.plays.length, pbp: G.plays,
        result: res, text, scorer, note: note || null, home: score[h], away: score[a] });
      start = (res === "TD" || res === "FG") ? K.TOUCHBACK : res === "Punt" ? clip(Math.round(100 - end - R.normal(42, 8)), 5, 40) : clip(100 - end, 5, 80);
      return res === "TD" ? "TD" : pts === 3 ? "FG" : "none";
    };
    const half = (n, recv, qa, note) => { start = K.TOUCHBACK; const other = recv === h ? a : h;
      for (let i = 0; i < n; i++) play(i % 2 === 0 ? recv : other, i < Math.ceil(n / 2) ? qa : qa + 1, i === 0 ? note : null); };
    half(h1, recv1, 1, `${nameOf(tossWin)} win the toss and defer. ${nameOf(recv1)} receive.`);
    half(h2, recv2, 3, `Second half: ${nameOf(recv2)} receive.`);
    const regDrives = drives.length;
    let overtime = false, tie = false;
    if (score[h] === score[a]) { // 2025+ regular-season overtime
      overtime = true; start = K.TOUCHBACK;
      const first = R.u() < 0.5 ? h : a, second = first === h ? a : h;
      const r1 = play(first, 5, `Overtime: ${nameOf(first)} win the toss and receive.`, "OT");
      start = K.TOUCHBACK;
      play(second, 5, null, r1 === "TD" ? "needTD" : "OT");
      let k2 = 0; while (score[h] === score[a] && k2 < 4) { play(k2 % 2 === 0 ? first : second, 6, null, "OT"); k2++; }
      tie = score[h] === score[a];
    }
    // game clock: each half's plays share 30 minutes; overtime is 10 minutes
    const halves = [drives.slice(0, h1), drives.slice(h1, regDrives), drives.slice(regDrives)];
    halves.forEach((ds, hi) => { const n = ds.reduce((x, d) => x + d.pbp.length, 0) || 1, len = hi < 2 ? 1800 : 600, per = len / n;
      let el = 0; ds.forEach(d => d.pbp.forEach(pl => { el += per; const gameSec = hi < 2 ? hi * 1800 + el : 3600 + el;
        pl.t = Math.min(gameSec, hi < 2 ? (hi + 1) * 1800 : 4200);
        const qs = hi < 2 ? Math.min(4, Math.floor((pl.t - 0.001) / 900) + 1) : 5; pl.q = qs;
        const left = hi < 2 ? qs * 900 - pl.t : 4200 - pl.t; pl.clock = `${Math.floor(Math.max(0, left) / 60)}:${String(Math.round(Math.max(0, left) % 60)).padStart(2, "0")}`; }));
      ds.forEach(d => { if (d.pbp.length) d.q = d.pbp[0].q; }); });
    // win probability after every play: quick re-simulation of the rest of the game from that moment
    const lgTd = tdFrom(30), WPN = opt.wpSims || 260, WR = rng((opt.seed || 7) * 31 + 5);
    const finishGame = (sh, sa, poss, yl, drivesLeft) => { // home win chance
      let w = 0;
      for (let k = 0; k < WPN; k++) {
        let H = sh, A = sa, t = poss;
        if (poss) { const r = rates[t], ptd = clip(tdFrom(yl) * r.ptd / lgTd, 0.02, 0.92), pfg = clip(fgFrom(yl) * (r.pfg / 0.2), 0, 0.6 - 0 * ptd), x = WR.u();
          const pts = x < ptd ? 7 : x < ptd + pfg ? 3 : 0; if (t === h) H += pts; else A += pts; t = t === h ? a : h; }
        else t = WR.u() < 0.5 ? h : a;
        for (let d = 0; d < drivesLeft; d++) { const r = rates[t], x = WR.u(); const pts = x < r.ptd ? 7 : x < r.ptd + r.pfg ? 3 : 0; if (t === h) H += pts; else A += pts; t = t === h ? a : h; }
        w += H > A ? 1 : H === A ? 0.5 : 0;
      }
      return w / WPN;
    };
    const wp = [{ t: 0, wp: finishGame(0, 0, null, 25, regDrives), d: -1, p: -1 }];
    let sH = 0, sA = 0;
    drives.forEach((d, di) => {
      const left = Math.max(0, regDrives - di - 1);
      d.pbp.forEach((pl, pi) => {
        const last = pi === d.pbp.length - 1;
        let v;
        if (!last) v = finishGame(sH, sA, d.team, clip(pl.yl + pl.gain, 1, 99), left);
        else { const H2 = d.home, A2 = d.away; v = di >= regDrives - 1 && !overtime ? (H2 > A2 ? 1 : H2 < A2 ? 0 : 0.5) : finishGame(H2, A2, null, 25, left); }
        if (overtime && di >= regDrives) v = last && di === drives.length - 1 ? (d.home > d.away ? 1 : d.home < d.away ? 0 : 0.5) : finishGame(d.home, d.away, last ? null : d.team, clip(pl.yl + pl.gain, 1, 99), 1);
        pl.wp = v; wp.push({ t: pl.t, wp: v, d: di, p: pi });
      });
      sH = d.home; sA = d.away;
      d.wpStart = di === 0 ? wp[0].wp : drives[di - 1].pbp.length ? drives[di - 1].pbp[drives[di - 1].pbp.length - 1].wp : wp[0].wp;
      d.wpEnd = d.pbp.length ? d.pbp[d.pbp.length - 1].wp : d.wpStart; d.swing = d.wpEnd - d.wpStart;
    });
    return { home: h, away: a, drives, overtime, tie, toss: tossWin, final: { [h]: score[h], [a]: score[a] }, wp, length: overtime ? 4200 : 3600, spot };
  }

  root.EdgeSim = { simulate, summarise, replay, rng };
})(typeof window !== "undefined" ? window : globalThis);
