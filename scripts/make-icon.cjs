// Renders the Lattice mark into build/icon.png (512×512) for the installer and the window.
// Offscreen rendering keeps the rounded corners transparent. Run with: npm run icon
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 512;
const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">
<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect x="16" y="16" width="480" height="480" rx="112" fill="#151618"/>
  <rect x="16.5" y="16.5" width="479" height="479" rx="111.5" fill="none" stroke="#2a2b30"/>
  <g transform="translate(76 76) scale(13.85)">
    <path d="M13 3 L23 13 L13 23 L3 13 Z" stroke="#8b7cf6" stroke-width="1.6" stroke-linejoin="round" fill="none" opacity="0.6"/>
    <path d="M8 8 L18 18 M18 8 L8 18" stroke="#8b7cf6" stroke-width="1.6" stroke-linecap="round" opacity="0.6"/>
    <circle cx="13" cy="3.5" r="2.4" fill="#a094f8"/>
    <circle cx="22.5" cy="13" r="2.4" fill="#a094f8"/>
    <circle cx="13" cy="22.5" r="2.4" fill="#a094f8"/>
    <circle cx="3.5" cy="13" r="2.4" fill="#a094f8"/>
  </g>
</svg></body></html>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    transparent: true,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  let loaded = false;
  let frames = 0;
  win.webContents.on('paint', (_e, _dirty, image) => {
    // skip the first frames after load so the SVG is fully painted
    if (!loaded || ++frames < 3) return;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, image.resize({ width: SIZE, height: SIZE }).toPNG());
    console.log(`icon written: ${out}`);
    app.exit(0);
  });
  win.webContents.setFrameRate(30);
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  loaded = true;
  win.webContents.invalidate();
  setTimeout(() => {
    console.error('icon: no frame painted');
    app.exit(1);
  }, 15000);
});
