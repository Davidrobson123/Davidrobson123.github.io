// Expected margin for each listed future game from the simulator's team ratings (no betting line to anchor to).
// node remaining.js model_week.json in.json out.json      in: [[home, away], ...]
const fs=require('fs'), path=require('path'); eval(fs.readFileSync(path.join(__dirname,'viz/simcore.js'),'utf8'));
const [mp, inp, outp]=process.argv.slice(2), M=JSON.parse(fs.readFileSync(mp)), G=JSON.parse(fs.readFileSync(inp)), out=[];
G.forEach(([h,a],i)=>{ const S=EdgeSim.simulate(M,h,a,{n:2500,seed:7000+i}); let m=0; for(let k=0;k<S.n;k++) m+=S.res[h].pts[k]-S.res[a].pts[k]; out.push(+(m/S.n).toFixed(2)); });
fs.writeFileSync(outp, JSON.stringify(out));
