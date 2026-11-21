// Renders an SVG to PNG at a given size using Electron (no extra dependencies).
// Usage: npx electron tools/render-svg.js <in.svg> <out.png> <size>
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const [inp, out, size] = process.argv.slice(-3);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const n = Number(size);
  const win = new BrowserWindow({ width: n, height: n, show: false, transparent: true, frame: false, useContentSize: true,
    webPreferences: { offscreen: true, zoomFactor: 1 } });
  const svg = fs.readFileSync(path.resolve(inp), 'utf8');
  const html = `<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" style="width:${n}px;height:${n}px;display:block"></body></html>`;
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  await new Promise(r => setTimeout(r, 300));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.resolve(out), img.resize({ width: n, height: n, quality: 'best' }).toPNG());
  app.exit(0);
});
