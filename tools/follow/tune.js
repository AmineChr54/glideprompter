// Grid search over FollowMotion parameters with sim.js. Usage: node tools/follow/tune.js <hyp-prefix>
const { simulate, files, setMotion } = require('./sim.js');
const grid = JSON.parse(process.env.GRID || 'null') || { lag: [0.35, 0.45, 0.6], maxLead: [0.7, 0.9, 1.2], k: [5, 7], tau: [0.06, 0.09] };
const keys = Object.keys(grid), combos = [{}];
for (const k of keys) { const next = []; for (const c of combos) for (const v of grid[k]) next.push({ ...c, [k]: v }); combos.splice(0, combos.length, ...next); }
const rows = [];
for (const c of combos) {
  setMotion(c);
  const rs = files.map(simulate);
  const avg = (f) => rs.reduce((s, r) => s + f(r), 0) / rs.length;
  rows.push({ ...c, lag50: Math.round(avg(r => r.disp.lag50)), lag95: Math.round(avg(r => r.disp.lag95)), lag05: Math.round(avg(r => r.disp.lag05)), p50: Math.round(avg(r => r.disp.p50)), p95: Math.round(avg(r => r.disp.p95)), err: +avg(r => r.disp.errMean).toFixed(2),
    abs95: +avg(r => r.disp.errAbsP95).toFixed(2), ahead2: +avg(r => r.disp.ahead2).toFixed(1), behind2: +avg(r => r.disp.behind2).toFixed(1),
    stop: Math.round(avg(r => r.disp.stopP50)), start: Math.round(avg(r => r.disp.startP50)), drift: +avg(r => r.disp.driftMax).toFixed(2) });
}
rows.sort((a, b) => (a.lag95 + 60 * a.ahead2) - (b.lag95 + 60 * b.ahead2));
for (const r of rows.slice(0, 12)) console.log(JSON.stringify(r));
