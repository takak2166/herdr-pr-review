// The preview of a Markdown file of a pull request, at its head commit, with comments placed on
// what is shown instead of on lines of the diff. It is drawn here, block by block (headings,
// paragraphs, list items, tables, quotes, code); each block knows the lines it came from.
// Pressing a block opens the review's comment box on its lines, as the + of a line does; the
// comments then go out with the review like any other. Only lines in the diff take a comment
// (GitHub's rule), so a part of a changed file that the pull request didn't touch says so.
// Mermaid diagrams (```mermaid blocks) are drawn by Mermaid in headless Chrome (render-mermaid.mjs)
// into SVGs kept under data/pr-review/mermaid/cache/, from the copy of Mermaid in
// data/pr-review/mermaid/mermaid.min.js (installed once from npm; nothing is sent anywhere).

import { div, image, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { exec, home, appHome, settings } from "herdr";
import * as fs from "fs/promises";
import { fileAt } from "./code.js";
import { L } from "./i18n.js";

const R = { sm: 4, md: 8, lg: 12, full: 9999 };
// Sizes and pointer positions come zoomed by the app's zoom setting; layout lengths are not.
const unzoom = (v) => (v == null ? v : v / (Number(settings().zoom) || 1));

/** "md" for a file the preview can show, else null. */
export function previewKind(file) {
  if (!file || file.deleted) return null;
  if (/\.(md|markdown|mdx)$/i.test(file.path)) return "md";
  return null;
}

// ---- Markdown, as blocks with their lines ------------------------------------------------------

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}#{1,6}(\s|$)/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)/;
const QUOTE = /^\s{0,3}>/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const blank = (s) => s.trim() === "";

/** `[{ start, end, text, indent }]`: the blocks of a Markdown text, lines counted from 1. A list
 *  item is a block of its own (its nesting kept as `indent`), its continuation lines with it. */
export function mdBlocks(source) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  const add = (start, end, text, indent = 0) => blocks.push({ start: start + 1, end: end + 1, text, indent });
  let i = 0;
  // Front matter is shown as it is written.
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, k) => k > 0 && l.trim() === "---");
    if (close > 0) { add(0, close, "```yaml\n" + lines.slice(1, close).join("\n") + "\n```"); i = close + 1; }
  }
  const startsBlock = (k) => FENCE.test(lines[k]) || HEADING.test(lines[k]) || ITEM.test(lines[k]) || QUOTE.test(lines[k]) || RULE.test(lines[k]) || isTable(k);
  const isTable = (k) => lines[k]?.includes("|") && TABLE_SEP.test(lines[k + 1] ?? "") && lines[k + 1].includes("-");
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      let k = i + 1;
      while (k < lines.length && !(lines[k].trim().startsWith(fence[1][0].repeat(fence[1].length)) && lines[k].trim().replace(new RegExp(`^\\${fence[1][0]}+`), "").trim() === "")) k++;
      const end = Math.min(k, lines.length - 1);
      add(i, end, lines.slice(i, end + 1).join("\n") + (k >= lines.length ? "\n" + fence[1] : ""));
      i = end + 1;
      continue;
    }
    if (HEADING.test(line) || RULE.test(line)) { add(i, i, line.trim()); i++; continue; }
    if (isTable(i)) {
      let k = i;
      while (k + 1 < lines.length && !blank(lines[k + 1]) && lines[k + 1].includes("|")) k++;
      add(i, k, lines.slice(i, k + 1).join("\n"));
      i = k + 1;
      continue;
    }
    if (QUOTE.test(line)) {
      let k = i;
      while (k + 1 < lines.length && QUOTE.test(lines[k + 1])) k++;
      add(i, k, lines.slice(i, k + 1).join("\n"));
      i = k + 1;
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      // The item's own lines: those after it indented past its marker, up to the next item or a blank line.
      const lead = item[1].replace(/\t/g, "    ").length;
      const body = lead + item[2].length + 1;
      let k = i;
      while (k + 1 < lines.length && !blank(lines[k + 1]) && !ITEM.test(lines[k + 1]) && !startsBlock(k + 1)) k++;
      const text = [line.slice(item[1].length), ...lines.slice(i + 1, k + 1).map((l) => l.replace(new RegExp(`^\\s{0,${body}}`), "  "))].join("\n");
      add(i, k, text, Math.floor(lead / 2));
      i = k + 1;
      continue;
    }
    let k = i;
    while (k + 1 < lines.length && !blank(lines[k + 1]) && !startsBlock(k + 1)) k++;
    add(i, k, lines.slice(i, k + 1).map((l) => l.trimStart()).join("\n"));
    i = k + 1;
  }
  return blocks;
}

// ---- Mermaid, drawn by Chrome -----------------------------------------------------------------

const MERMAID = "data/pr-review/mermaid";
// Part of each image's name: a change in how diagrams are drawn gets new files (Herdr keeps an image
// it has loaded by its path).
const DRAW_V = 5;
const MERMAID_FENCE = /^\s{0,3}(`{3,}|~{3,})\s*mermaid\b[^\n]*\n([\s\S]*?)\n?\s{0,3}\1\s*$/;

let nodePath = null;
// A node new enough to have WebSocket (22+): mise's newest install, else Homebrew's, else the PATH's.
async function nodeBin() {
  if (nodePath) return nodePath;
  const dir = `${home()}/.local/share/mise/installs/node`;
  const versions = (await fs.exists(dir)) ? (await fs.readdir(dir)).filter((n) => /^\d+\.\d+\.\d+$/.test(n)) : [];
  versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const candidates = [...versions.filter((x) => Number(x.split(".")[0]) >= 22).map((x) => `${dir}/${x}/bin/node`), "/opt/homebrew/bin/node", "/usr/local/bin/node"];
  for (const c of candidates) if (await fs.exists(c)) return (nodePath = c);
  return (nodePath = "node");
}

function hash(text) {
  let a = 5381, b = 52711;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = ((a * 33) ^ c) >>> 0; b = ((b * 31) ^ c) >>> 0; }
  return a.toString(36) + b.toString(36);
}

// Each ```mermaid block of the preview gets `mermaid` (its code) at once, and later `diagram`
// (`{ src, w, h }`) or `diagramError`. Diagrams drawn before come from the cache; the rest are
// drawn together, in one Chrome.
async function drawDiagrams(v, key, cx) {
  const blocks = v.preview.blocks.filter((b) => { const m = MERMAID_FENCE.exec(b.text); if (m) { b.mermaid = m[2]; b.mermaidKey = `${hash(m[2])}-${DRAW_V}`; } return Boolean(m); });
  if (!blocks.length) return;
  const root = `${appHome()}/${MERMAID}`;
  const cache = `${root}/cache`;
  const lib = `${root}/mermaid.min.js`;
  const fill = async () => {
    for (const b of blocks) {
      const meta = await fs.readFile(`${cache}/${b.mermaidKey}.json`, "utf8").catch(() => null);
      if (!meta) continue;
      const size = JSON.parse(meta);
      if (size.error) b.diagramError = size.error;
      else b.diagram = { src: `${MERMAID}/cache/${b.mermaidKey}.svg`, w: size.vw, h: size.vh };
    }
  };
  try {
    if (!(await fs.exists(lib))) throw new Error(L(`Mermaid が入っていません（${MERMAID}/mermaid.min.js）。README の手順で入れてください。`, `Mermaid is not installed (${MERMAID}/mermaid.min.js); see the README.`));
    await fs.mkdir(cache, { recursive: true });
    await fill();
    const jobs = [...new Map(blocks.filter((b) => !b.diagram && !b.diagramError).map((b) => [b.mermaidKey, { key: b.mermaidKey, code: b.mermaid }])).values()];
    if (jobs.length) {
      const list = `${cache}/jobs-${Date.now()}.json`;
      await fs.writeFile(list, JSON.stringify(jobs));
      const r = await exec(await nodeBin(), [`${appHome()}/mods/pr-review/render-mermaid.mjs`, lib, list, cache], { timeout: 120000 });
      await fs.unlink(list).catch(() => {});
      if (r.code !== 0) throw new Error(L(`図を描けませんでした: ${(r.stderr || r.stdout).trim().split("\n")[0]}`, `Could not draw the diagrams: ${(r.stderr || r.stdout).trim().split("\n")[0]}`));
      await fill();
    }
  } catch (e) {
    for (const b of blocks) if (!b.diagram) b.diagramError ??= String(e?.message ?? e);
  }
  if (v.preview?.key === key) cx.notify();
}

// A Mermaid block: the diagram on white (shrunk to the room there is), or its code with why it
// isn't drawn (yet).
function diagram(v, t, b, id, room) {
  if (b.diagram) {
    const s = Math.min(1, Math.max(200, room) / b.diagram.w);
    // A press on the diagram enlarges it (pressing around it still picks the block for a comment).
    const w = b.diagram.w * s, h = b.diagram.h * s;
    return h_flex().items_start().child(div().id(`${id}-img`).relative().flex_none().w(w + 16).h(h + 16).p(8).rounded(R.md).bg("#ffffff").cursor_pointer()
      .tooltip(L("クリックで拡大", "Click to enlarge"))
      .on_click((_e, cx) => { cx.stop_propagation(); v.preview.zoom = { block: b, scale: 2 }; cx.notify(); })
      .child(image(b.diagram.src).flex_none().w(w).h(h))
      .child(div().absolute().top(6).right(6).size(22).flex().items_center().justify_center().rounded(R.sm).bg(t.background + "cc")
        .child(svg("mods/pr-review/icons/zoom-in.svg").size(14).text_color(t.muted))));
  }
  return v_flex().gap(4)
    .child(div().text_size(11).text_color(b.diagramError ? t.blocked : t.dim).child(b.diagramError ? L(`Mermaid の図を描けませんでした: ${b.diagramError}`, `Could not draw the Mermaid diagram: ${b.diagramError}`) : L("Mermaid の図を描いています…", "Drawing the Mermaid diagram…")))
    .child(TextView.markdown(id, b.text));
}

// An enlarged diagram over the preview, at 1x to 4x its size (an SVG, so it stays sharp), moved
// about by dragging it (or scrolling). Herdr draws an SVG into one texture, so the sizes that would make it wider or taller
// than MAX_SIDE are not offered. It closes with 閉じる; "コメント" picks its block.
const ZOOMS = [1, 1.5, 2, 3, 4];
const MAX_SIDE = 3600;
function zoomView(v, t) {
  const p = v.preview, z = p.zoom, d = z.block.diagram;
  const fits = (n) => n === 1 || Math.max(d.w, d.h) * n <= MAX_SIDE;
  if (!fits(z.scale)) z.scale = ZOOMS.filter(fits).pop();
  z.x ??= 24; z.y ??= 24;
  const cardW = d.w * z.scale + 32, cardH = d.h * z.scale + 32;
  // The card can be dragged (or scrolled) about, but not out of sight: an edge stops 24px inside.
  const clamp = () => {
    const aw = z.areaW ?? cardW + 48, ah = z.areaH ?? cardH + 48;
    z.x = Math.min(24, Math.max(Math.min(24, aw - cardW - 24), z.x));
    z.y = Math.min(24, Math.max(Math.min(24, ah - cardH - 24), z.y));
  };
  clamp();
  // Another size keeps the middle of the view where it is.
  const rescale = (n) => {
    const mx = (z.areaW ?? 0) / 2, my = (z.areaH ?? 0) / 2, k = n / z.scale;
    z.x = mx - (mx - z.x) * k; z.y = my - (my - z.y) * k;
    z.scale = n;
  };
  const close = () => { p.zoom = null; };
  const button = (id, label, on, act, tip) => div().id(id).flex_none().px(8).h(24).flex().items_center().rounded(R.sm).text_size(12)
    .bg(on ? t.selected : t.surface).text_color(on ? t.foreground : t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
    .when(Boolean(tip), (el) => el.tooltip(tip)).on_click((_e, cx) => { cx.stop_propagation(); act(); cx.notify(); }).child(label);
  return v_flex().id("pv-zoom").absolute().inset_0().bg(t.background)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .child(h_flex().h(36).flex_none().px(12).gap(4).items_center().border_b(1).border_color(t.border)
      .child(div().flex_none().text_size(12).text_color(t.muted).child(`${lineLabel(z.block.start, z.block.end)} · Mermaid`))
      .child(div().flex_none().pl(12).text_size(11).text_color(t.dim).child(L("ドラッグで移動", "Drag to move")))
      .child(div().flex_1())
      .children(ZOOMS.filter(fits).map((n) => button(`pv-zoom-${n}`, `${n}×`, z.scale === n, () => rescale(n))))
      .child(div().w(8))
      .child(button("pv-zoom-comment", L("この図にコメント", "Comment on this diagram"), false, () => { const b = z.block; close(); pick(v, b.start, b.end, lineLabel(b.start, b.end)); }))
      .child(button("pv-zoom-close", L("閉じる", "Close"), false, close, L("拡大をやめる", "Stop enlarging"))))
    .child(div().id("pv-zoom-area").flex_1().min_h(0).relative().overflow_hidden()
      .when(Boolean(z.drag), (el) => el.cursor_grabbing()).when(!z.drag, (el) => el.cursor_grab())
      .on_size_change((size, cx) => { z.areaW = unzoom(size.width); z.areaH = unzoom(size.height); cx.notify(); })
      .on_mouse_down("left", (e, cx) => { z.drag = { x: unzoom(e.position.x), y: unzoom(e.position.y), ox: z.x, oy: z.y }; cx.notify(); })
      .on_mouse_move((e, cx) => {
        if (!z.drag) return;
        z.x = z.drag.ox + (unzoom(e.position.x) - z.drag.x);
        z.y = z.drag.oy + (unzoom(e.position.y) - z.drag.y);
        clamp();
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => { if (z.drag) { z.drag = null; cx.notify(); } })
      .on_scroll_wheel((e, cx) => { z.x += unzoom(e.delta?.x ?? 0); z.y += unzoom(e.delta?.y ?? 0); clamp(); cx.notify(); })
      .child(div().id("pv-zoom-img").absolute().left(z.x).top(z.y).w(cardW).h(cardH).p(16).rounded(R.md).bg("#ffffff")
        .child(image(d.src).flex_none().w(d.w * z.scale).h(d.h * z.scale))));
}

// ---- state -------------------------------------------------------------------------------------

/** Loads the preview of the file shown, when the view is the preview and it shows another file
 *  (or another commit, or another width). Called on every draw; does nothing when it is up to date. */
export function ensurePreview(v, cx) {
  if (v.view !== "preview" || !v.picked) return;
  const file = v.current();
  const kind = previewKind(file);
  if (!kind) { v.view = "diff"; return; }
  const key = `${v.picked.url}|${v.picked.sha}|${file.path}`;
  if (v.preview?.key === key) return;
  const pr = v.picked;
  v.preview = { key, path: file.path, kind, busy: true, error: null, sel: null, hover: null, note: null };
  cx.spawn(async (cx) => {
    const still = () => v.preview?.key === key;
    try {
      const text = await fileAt(pr, file.path);
      if (!still()) return;
      v.preview.blocks = mdBlocks(text);
      drawDiagrams(v, key, cx);
    } catch (e) {
      if (still()) v.preview.error = String(e?.message ?? e);
    }
    if (still()) { v.preview.busy = false; cx.notify(); }
  });
}

/** Between the diff and the preview of the file shown. */
export function togglePreview(v) {
  v.view = v.view === "preview" ? "diff" : "preview";
  if (v.view === "diff") v.preview = null;
}

// The comments of the file shown on the head side: GitHub's, thread by thread, and your drafts.
function commentsHere(v) {
  const path = v.preview?.path;
  const threads = (v.detail?.threads ?? []).filter((c) => !c.outdated && c.path === path && c.side === "RIGHT" && c.line != null);
  const roots = new Map();
  for (const c of threads) { const root = c.reply ?? c.id; if (!roots.has(root)) roots.set(root, []); roots.get(root).push(c); }
  const items = [...roots.entries()].map(([root, list]) => ({ kind: "thread", root, line: list[0].line, start: list[0].line, list }));
  v.draftsOf().forEach((d, index) => {
    if (d.reply) { const it = items.find((x) => x.root === d.reply); if (it) (it.drafts ??= []).push({ d, index }); return; }
    if (d.path === path && d.side === "RIGHT") items.push({ kind: "draft", line: d.line, start: d.startLine ?? d.line, d, index });
  });
  return items.sort((a, b) => a.line - b.line);
}

// The lines of the diff a comment on `start`..`end` of the head file can sit on: all of them when
// they are one stretch of one hunk, else the first one in the diff; null when none is.
function target(v, start, end) {
  const file = v.current();
  const rows = (file?.rows ?? []).filter((r) => r.side === "RIGHT" && r.line >= start && r.line <= end && (r.kind === "+" || r.kind === " "));
  if (!rows.length) return null;
  const first = rows[0], last = rows[rows.length - 1];
  const whole = rows.length === last.line - first.line + 1 && v.hunkOf(first) === v.hunkOf(last);
  return whole && last.line > first.line ? { startLine: first.line, line: last.line } : { startLine: null, line: first.line };
}

// A block was pressed: the comment box opens on its lines (what is written so far stays).
function pick(v, start, end, label) {
  const p = v.preview;
  p.sel = { start, end };
  const to = target(v, start, end);
  if (!to) {
    p.note = L(`${label} は差分に含まれていない（この PR で変わっていない）行なので、コメントできません。`, `${label} is not in the diff (this pull request didn't change it), so it can't take a comment.`);
    return;
  }
  p.note = null;
  const keep = v.compose && v.compose.index == null && !v.compose.reply;
  v.composeNote = null;
  v.compose = { path: p.path, line: to.line, side: "RIGHT", index: null, reply: null, to: null, startLine: to.startLine };
  if (!keep) v.editor.set_value("");
  v.editor.focus();
}

/** What line `n` of the file shows, pressed: the block holding it. */
export function pickLine(v, n) {
  const p = v.preview;
  if (!p || p.busy || !n) return;
  const b = p.blocks?.find((x) => n >= x.start && n <= x.end);
  if (b) pick(v, b.start, b.end, lineLabel(b.start, b.end));
}

const lineLabel = (start, end) => (end > start ? `L${start}–${end}` : `L${start}`);

// ---- drawing -----------------------------------------------------------------------------------

/** The preview pane: what the file shows on the left, its comments on the right. */
export function previewPane(v, t) {
  const p = v.preview;
  const items = p ? commentsHere(v) : [];
  return div().flex().flex_row().flex_1().min_h(0).min_w(0)
    .child(v_flex().flex_1().min_w(0).min_h(0)
      .child(toolbar(v, t))
      .child(div().id("pv-pane").flex_1().min_h(0).relative()
        .on_size_change((size, cx) => { const w = unzoom(size.width); if (Math.abs((v.previewPaneW ?? 0) - w) >= 8) { v.previewPaneW = w; cx.notify(); } })
        .when(!p || p.busy, (el) => el.child(div().p(16).text_size(12).text_color(t.dim).child(L("読み込み中…", "Loading…"))))
        .when(Boolean(p?.error), (el) => el.child(div().p(16).text_size(12).text_color(t.blocked).child(p.error)))
        .when(Boolean(p && !p.busy && !p.error), (el) => el.child(mdView(v, t, items)))
        .when(Boolean(p?.zoom), (el) => el.child(zoomView(v, t)))))
    .child(commentList(v, t, items));
}

function toolbar(v, t) {
  const p = v.preview;
  return h_flex().h(30).flex_none().px(8).gap(4).items_center().border_b(1).border_color(t.border).text_size(12)
    .child(div().flex_none().text_size(11).text_color(t.dim).child(L("ブロックを押すと、その行にコメントできます", "Press a block to comment on its lines")))
    .child(div().flex_1())
    .when(Boolean(p?.note), (el) => el.child(div().flex_none().max_w(520).truncate().text_size(11).text_color(t.blocked).child(p.note)));
}

function hasComment(items, start, end) {
  return items.filter((it) => it.line >= start && it.start <= end);
}

function mdView(v, t, items) {
  const p = v.preview;
  return div().id("pv-md").size_full().overflow_y_scroll()
    .child(v_flex().max_w(920).px(28).py(20).gap(2).text_size(14).text_color(t.foreground)
      .children(p.blocks.map((b, k) => {
        const on = p.sel && p.sel.start === b.start && p.sel.end === b.end;
        const here = hasComment(items, b.start, b.end);
        return div().id(`pvb-${k}`).relative().pl(8 + b.indent * 20).pr(36).py(4).rounded(R.sm).border(1)
          .border_color(on ? t.accent : "#00000000").when(on, (el) => el.bg(t.accent + "14"))
          .cursor_pointer().hover((s) => s.border_color(t.input))
          .tooltip(`${lineLabel(b.start, b.end)} ${L("にコメント", "· comment")}`)
          .on_click((_e, cx) => { pick(v, b.start, b.end, lineLabel(b.start, b.end)); cx.notify(); })
          .child(b.mermaid != null ? diagram(v, t, b, `pvmd-${p.key}-${k}`, (v.previewPaneW ?? 900) - 420) : TextView.markdown(`pvmd-${p.key}-${k}`, b.text))
          .when(here.length > 0, (el) => el.child(pin(t, here, 6, 4)));
      })));
}

// A count of the comments on something, orange when GitHub has one, gray for drafts only.
function pin(t, here, top, right) {
  const live = here.some((it) => it.kind === "thread");
  return div().absolute().top(top).right(right).h(20).min_w(20).px(6).flex().items_center().justify_center().rounded(R.full)
    .bg(live ? t.ansi3 : t.muted).text_size(11).font_bold().text_color(t.background).child(String(here.length));
}

// The comments of the file, in line order: GitHub's threads (with a reply button) and your drafts
// (with an edit button). Those on what is selected stand out; a press selects their place.
function commentList(v, t, items) {
  const p = v.preview;
  const md = (id, text) => div().text_size(12).text_color(t.foreground).child(TextView.markdown(id, text.length > 1500 ? `${text.slice(0, 1500)}…` : text));
  const small = (id, label, act) => div().id(id).flex_none().px(8).h(20).flex().items_center().rounded(R.sm).border(1).border_color(t.border).text_size(11).text_color(t.muted)
    .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { cx.stop_propagation(); act(); cx.notify(); }).child(label);
  const select = (it) => { p.sel = { start: it.start, end: it.line }; };
  const draftRow = ({ d, index }, key) => v_flex().gap(4).pl(8).border_l(2).border_color(t.muted)
    .child(h_flex().gap(6).items_center()
      .child(div().flex_none().px(6).rounded(R.sm).bg(t.muted + "33").text_size(10).text_color(t.muted).child(L("下書き", "Draft")))
      .child(div().flex_1())
      .child(small(`pv-edit-${key}`, L("編集", "Edit"), () => v.startDraft({ path: d.path, line: d.line, side: d.side }, index))))
    .child(md(`pv-d-${key}`, d.body));
  return v_flex().w(320).flex_none().min_h(0).border_l(1).border_color(t.border).bg(t.chrome)
    .child(h_flex().h(30).flex_none().px(12).items_center().border_b(1).border_color(t.border).text_size(11).font_medium().text_color(t.dim)
      .child(L(`このファイルのコメント（${items.length}）`, `Comments on this file (${items.length})`)))
    .child(div().id("pv-comments").flex_1().min_h(0).overflow_y_scroll()
      .child(v_flex().p(8).gap(8)
        .when(items.length === 0, (el) => el.child(div().p(8).text_size(12).text_color(t.dim).child(L("まだコメントはありません。左のプレビューで、ブロックを押すと書けます。", "No comments yet. Press a block in the preview to write one."))))
        .children(items.map((it, k) => {
          const on = p?.sel && it.line >= p.sel.start && it.start <= p.sel.end;
          const card = v_flex().id(`pv-c-${k}`).gap(6).p(8).rounded(R.md).border(1).border_color(on ? t.accent : t.border).bg(t.background)
            .cursor_pointer().hover((s) => s.border_color(t.input)).on_click((_e, cx) => { select(it); cx.notify(); })
            .child(div().text_size(11).text_color(t.dim).child(lineLabel(it.start, it.line)));
          if (it.kind === "draft") return card.child(draftRow(it, `${k}`));
          return card
            .children(it.list.map((c, j) => v_flex().gap(2).when(j > 0, (el) => el.pl(8))
              .child(div().text_size(11).font_medium().text_color(t.muted).child(`@${c.user}`))
              .child(md(`pv-t-${c.id}`, c.body))))
            .children((it.drafts ?? []).map((x, j) => draftRow(x, `${k}-${j}`)))
            .child(h_flex().gap(6).child(div().flex_1())
              .child(small(`pv-reply-${k}`, L("返信", "Reply"), () => { const last = it.list[it.list.length - 1]; v.startReply({ comment: last, root: it.root }); })));
        }))));
}





