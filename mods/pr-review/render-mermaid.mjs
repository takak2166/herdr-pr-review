// Draws Mermaid diagrams to SVG for the review screen's Markdown preview, which can't run Mermaid itself.
//   node render-mermaid.mjs <mermaid.min.js> <jobs.json> <out-dir>
// jobs.json is `[{ key, code }]`. Each diagram is laid out by Mermaid in headless Chrome (a throwaway
// profile, closed at the end), which measures its text, and saved as <out-dir>/<key>.svg with its
// labels as SVG text (not HTML), so any SVG renderer draws them. <out-dir>/<key>.json gives its size,
// `{ vw, vh }`, or why it couldn't be drawn, `{ error }`. Nothing is fetched from the
// network: Mermaid comes from the local file given.

import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.HERDR_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SCALE = 2, WIDTH = 1200;

const [lib, jobsPath, out] = process.argv.slice(2);
if (!lib || !jobsPath || !out) { process.stderr.write("usage: render-mermaid.mjs <mermaid.min.js> <jobs.json> <out-dir>\n"); process.exit(1); }
const jobs = JSON.parse(await readFile(jobsPath, "utf8"));

const profile = await mkdtemp(join(tmpdir(), "herdr-mermaid-"));
const page = join(profile, "page.html");
await writeFile(page, `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#fff;font-family:-apple-system,sans-serif}#box{display:inline-block;padding:16px}</style><div id="box"></div><script src="file://${lib}"></script><script>mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "strict", htmlLabels: false, flowchart: { htmlLabels: false }, themeVariables: { fontFamily: \"Hiragino Sans, Hiragino Kaku Gothic ProN, sans-serif\" } });</script>`);
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--allow-file-access-from-files", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const done = async (code) => { chrome.kill("SIGKILL"); await rm(profile, { recursive: true, force: true }).catch(() => {}); process.exit(code); };
const timer = setTimeout(() => { process.stderr.write("timed out\n"); done(1); }, 90000);

try {
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    chrome.stderr.on("data", (d) => { buf += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) resolve(m[1]); });
    chrome.on("exit", (c) => reject(new Error(`Chrome exited (${c})`)));
  });
  const port = new URL(wsUrl).port;
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("DevTools connection failed")); });
  let seq = 0;
  const waiting = new Map(), events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) { const { resolve, reject } = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); }
    else if (msg.method) events.push(msg.method);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: 800, deviceScaleFactor: SCALE, mobile: false });
  await send("Page.navigate", { url: `file://${page}` });
  for (let k = 0; k < 100 && !events.includes("Page.loadEventFired"); k++) await sleep(100);

  for (const [i, job] of jobs.entries()) {
    // Mermaid draws the diagram as SVG into the box.
    const expr = `(async () => {
      const box = document.getElementById("box");
      box.innerHTML = "";
      try {
        const { svg } = await mermaid.render("d${i}", ${JSON.stringify(job.code)});
        box.innerHTML = svg;
        const s = box.querySelector("svg");
        // Mermaid fits a diagram to the page's width; it is drawn at its own size instead (its viewBox).
        if (s) {
          const vb = s.viewBox && s.viewBox.baseVal;
          if (vb && vb.width) { s.setAttribute("width", String(vb.width)); s.setAttribute("height", String(vb.height)); }
          s.style.maxWidth = "none";
        }
        await document.fonts.ready;
        const r = box.getBoundingClientRect();
        return JSON.stringify({ w: Math.ceil(r.width), h: Math.ceil(r.height), svg: s ? new XMLSerializer().serializeToString(s) : null, vw: s ? Math.ceil(Number(s.getAttribute("width"))) : null, vh: s ? Math.ceil(Number(s.getAttribute("height"))) : null });
      } catch (e) {
        document.querySelectorAll("[id^=dd${i}]").forEach((n) => n.remove());
        return JSON.stringify({ error: String(e && e.message || e).split("\\n").slice(0, 3).join(" ") });
      }
    })()`;
    const res = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    const size = JSON.parse(res.result.value);
    if (size.svg) { await writeFile(join(out, `${job.key}.svg`), size.svg); delete size.svg; }
    await writeFile(join(out, `${job.key}.json`), JSON.stringify(size));
  }
  clearTimeout(timer);
  ws.close();
  await done(0);
} catch (e) {
  process.stderr.write(`${e?.message ?? e}\n`);
  await done(1);
}
