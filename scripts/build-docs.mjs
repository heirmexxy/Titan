// Renders docs/*.md that the website links to into styled HTML pages in web/docs/. Run: npm run docs
import { readFileSync, writeFileSync } from 'node:fs';
import { marked } from 'marked';

const pages = [
  ['docs/device-protocol-v1.md', 'web/docs/device-protocol.html', 'Titan Device Protocol v1'],
  ['docs/sensor-nodes.md', 'web/docs/sensor-nodes.html', 'Titan sensor nodes'],
];
const css = `body{margin:0;font-family:Archivo,Inter,system-ui,sans-serif;color:#14213D;background:#fff;line-height:1.6}
main{max-width:860px;margin:0 auto;padding:2rem 1.25rem 4rem}a{color:inherit}
nav{max-width:860px;margin:0 auto;padding:1rem 1.25rem;display:flex;gap:1.25rem;font-size:.95rem}nav b{font-weight:800;margin-right:auto}
h1{font-size:2.2rem;line-height:1.1;letter-spacing:-.02em}h2{margin-top:2.5rem;padding-top:.75rem;border-top:3px solid #14213D}
table{border-collapse:collapse;width:100%;font-size:.92rem;display:block;overflow-x:auto}th,td{text-align:left;padding:.45rem .7rem .45rem 0;border-bottom:1px solid #D5DEDA;vertical-align:top}
code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.88em;background:#EEF2F0;padding:.05rem .3rem;border-radius:4px}
pre{background:#14213D;color:#DCE6E2;padding:1rem 1.2rem;border-radius:8px;overflow-x:auto;font-size:.85rem}pre code{background:none;color:inherit;padding:0}`;
for (const [src, out, title] of pages) {
  const html = marked.parse(readFileSync(src, 'utf8').replace(/\]\(device-protocol-v1\.md\)/g, '](device-protocol.html)').replace(/\]\(sensor-nodes\.md\)/g, '](sensor-nodes.html)'));
  writeFileSync(out, `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&display=swap" rel="stylesheet"><style>${css}</style></head>
<body><nav aria-label="Docs"><b>Titan</b><a href="../index.html">Home</a><a href="index.html">Integration Guide</a><a href="device-protocol.html">Device protocol</a><a href="sensor-nodes.html">Sensor nodes</a></nav><main>${html}</main></body></html>`);
  console.log('wrote', out);
}
