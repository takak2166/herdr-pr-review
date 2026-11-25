// PR Review: open pull requests grouped by what to do next, stacked ones under the one they build
// on; one pull request's details and diff, file by file in a tree, with GitHub's Viewed marks; line
// comments sent as one review; a code view with definitions, uses, blame and search; and a Claude
// Code session about the pull request beside it. The words are Japanese or English (i18n.js).
// Two roles (props.role), placed by the layout:
//   (none)       the review screen itself
//   "chat-head"  the bar over the terminal that opens on the right for the Claude Code session
// Reading goes through `gh`; the only thing written to GitHub is a review, when you send one.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, EditorState, Editor, TextView, Scrollbar, v_virtual_list, VirtualListScrollHandle, ScrollHandle } from "gpui-base";
import { exec, hc, run, theme, settings, spaces, panes, props, home, appHome, readTextFile, notify, setShared, nextCommand, checking } from "herdr";
import * as fs from "fs/promises";
import { searchPrs, prDetail, prDiff, submitReview, slackThreads, viewedFiles, setViewed } from "./github.js";
import { parseDiff, treeOrder } from "./diff.js";
import { L, setLang, currentLang, macLang } from "./i18n.js";
import { languageOf, highlightLine, sliceSegs } from "./highlight.js";
import { fileAt, definitions, references, goplsReferences, goplsDefinition, blameLine, wordAt } from "./code.js";
import { previewKind, ensurePreview, togglePreview, previewPane, pickLine } from "./preview.js";

// The lists are asked for again this often.
const LIST_MS = 300000;
// A diff longer than this many lines is cut (GitHub has the rest).
const MAX_LINES = 20000;
// A tab of your own (config.json `tabs`) lists up to this many pull requests.
const TAB_LIMIT = 200;
// Shapes follow the Nest UI design system: radii of 4 / 8 / 12 or full, spacing on a 4px grid,
// text at 11 / 12 / 14 in regular, medium or bold, line icons instead of glyphs.
// Colors are the theme's: that system is light only.
const R = { sm: 4, md: 8, lg: 12, full: 9999 };
const ico = (name, size, color) => svg(`mods/pr-review/icons/${name}.svg`).size(size).flex_none().text_color(color);
const ROW_H = 20;
// The panes the person can widen or narrow by dragging the line beside them.
const PANES = { list: { start: 360, min: 160, max: 640 }, files: { start: 250, min: 160, max: 560 }, side: { start: 400, min: 280, max: 800 } };

// The two tabs that are always there, as on GitHub's Pull requests page; more come from config.json.
const TABS = [
  { id: "requested", label: () => L("レビュー依頼", "Review requests"), query: "review-requested:@me" },
  { id: "mine", label: () => L("自分の PR", "My PRs"), query: "author:@me" },
];
// The order within a group.
const SORTS = [
  { id: "updated", label: () => L("更新順", "Updated") },
  { id: "new", label: () => L("新しい順", "Newest") },
  { id: "old", label: () => L("古い順", "Oldest") },
];
// What to do with a pull request now: the list is always split into these, in this order.
const GROUPS = [
  { id: "read", label: () => L("レビューする", "To review"), hint: () => L("あなたのレビューを待っている", "waiting for your review") },
  { id: "act", label: () => L("対応する", "To fix"), hint: () => L("あなたの PR で、次はあなたが動く", "your pull requests, your move") },
  { id: "wait", label: () => L("返事待ち", "Waiting"), hint: () => L("作者かレビュワーが動く番", "the author or a reviewer moves next") },
  { id: "watch", label: () => L("ウォッチ", "Watching"), hint: () => L("今は何もしなくてよい", "nothing to do for now") },
];
const GROUP_AT = Object.fromEntries(GROUPS.map((g, i) => [g.id, i]));
// The labels a comment can start with: a shields.io badge, as the team writes them on GitHub.
// `color` is the badge's own, for the chip that inserts it.
const TAGS = [
  { id: "ask", color: "#007ec6", badge: "![ask](https://img.shields.io/badge/review-ask-informational.svg)" },
  { id: "imo", color: "#dfb317", badge: "![imo](https://img.shields.io/badge/review-imo-yellow.svg)" },
  { id: "nits", color: "#9f9f9f", badge: "![nits](https://img.shields.io/badge/review-nits-lightgrey.svg)" },
  { id: "tsubuyaki", color: "#66ccff", badge: "![tsubuyaki](https://img.shields.io/badge/review-tsubuyaki-9cf.svg)" },
];
// A label at the start of a comment: one of the badges above, and what follows it.
const LABEL = /^!\[(ask|imo|nits|tsubuyaki)\]\(https:\/\/img\.shields\.io\/badge\/[^)]*\)\s*/;
// The questions "Ask Claude" offers when config.json has none of its own (`prompts`).
const defaultPrompts = () => [
  { label: L("レビューして", "Review"), ask: L("この PR をレビューしてください。気になる点を、重要なものから順に、該当する行と合わせて挙げてください。", "Please review this pull request. List what concerns you, most important first, each with the lines involved.") },
  { label: L("図解して", "Diagram"), ask: L("この PR の変更を図にしてください。関わる部品と処理の流れが分かる図（Mermaid かテキスト）と、短い説明をお願いします。", "Please draw this pull request's change: a diagram of the parts and the flow involved (Mermaid or text), with a short explanation.") },
];
// The name of a pull request's Claude Code tab ends with this (the older Japanese ending is recognized too).
const CHAT_SUFFIX = " review", OLD_CHAT_SUFFIX = " レビュー";
const isChatTab = (name) => name.endsWith(CHAT_SUFFIX) || name.endsWith(OLD_CHAT_SUFFIX);
// What a file with no lines in the diff says instead (diff.js marks why).
const emptyText = (why) => (why === "renamed" ? L("中身の変更はありません（名前の変更のみ）", "No change to the content (renamed only)") : L("表示できる差分がありません（バイナリか、大きすぎるファイル）", "No diff to show (binary, or too large)"));
// The code view's language for a file, by its extension (as the shipped file viewer names them).
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const MAX_CODE = 400000;

// An inline comment shows whole, wrapped to its box. The list needs every row's height before it
// draws, so the wrapping is done here, by the width each character takes in the diff's font --
// and so is the Markdown, as far as it keeps one line one line: quotes, code, bold, headings, lists.
// Tables, images and diagrams stay as written.
const CHAR_W = 7, WIDE_W = 12, COMMENT_LINE = 17, COMMENT_MAX_LINES = 120, QUOTE_PAD = 12;
const charW = (ch) => (ch.charCodeAt(0) < 0x2e80 ? CHAR_W : WIDE_W);
// Where a pointer lands in a line of the diff: the diff's monospace font at 12px is 0.6em a character.
const HIT_W = 7.2, HIT_WIDE = 12;
// Where text starts in a row: one column [+ 20][number 40][mark 8] with gaps of 12; a half of a
// side-by-side row [+ 20][number 40][mark 8] with gaps of 8; a line of the code view [number 48] and 12.
const ONE_X0 = 104, HALF_X0 = 92, PLUS_W = 24, CODE_X0 = 60;
// The sizes above are at zoom 1, as the layout is written. A pointer's position arrives in the
// window's pixels, which the person's zoom scales (settings.json `zoom`): these turn a position, or
// an element's width, back into the layout's own pixels before it is compared with them.
const unzoom = (v) => (v == null ? v : v / (Number(settings().zoom) || 1));
const localOf = (e) => (e.local_position ? { x: unzoom(e.local_position.x), y: unzoom(e.local_position.y) } : null);
// A file of up to this many rows is drawn whole, so each line can follow the pointer (the + shows on the
// line under it, and a drag from a + across lines makes a multi-line comment). A longer file is drawn
// as a list of what is on screen, where the + shows only when the pointer is on it.
const PLAIN_MAX = 1500;
// Tabs to spaces for the code view (the diff does this when it reads the patch).
const untabLine = (text) => (text.includes("\t") ? text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4)) : text);
const IDENT = /[A-Za-z0-9_$]/;
/** The name (identifier) at `x` px into `text`, or null. */
function nameAtX(text, x) {
  return wordAtX(text, x)?.name ?? null;
}

/** The name at `x` px into `text`, whether a `.` comes right before it (`u.name`: a member, never a
 *  variable of a function) and where it starts (in characters), or null. */
function wordAtX(text, x) {
  const chars = [...text];
  const w = (ch) => (ch.charCodeAt(0) < 0x2e80 ? HIT_W : HIT_WIDE);
  let at = 0, used = 0;
  while (at < chars.length && used + w(chars[at]) <= x) { used += w(chars[at]); at++; }
  if (at >= chars.length || !IDENT.test(chars[at])) return null;
  let a = at, b = at;
  while (a > 0 && IDENT.test(chars[a - 1])) a--;
  while (b < chars.length && IDENT.test(chars[b])) b++;
  const name = chars.slice(a, b).join("");
  return /^[A-Za-z_$]/.test(name) ? { name, member: chars[a - 1] === ".", start: a } : null;
}

/** Which of `name`'s places as a word in `text` (from 1) starts at character `start`: gopls is
 *  asked about that one (`x := u.x()` has the name twice). */
function placeOf(text, name, start) {
  const chars = [...text];
  let n = 0;
  for (let i = 0; i <= start && i < chars.length; i++) {
    if (chars.slice(i, i + name.length).join("") !== name) continue;
    if (i > 0 && IDENT.test(chars[i - 1])) continue;
    if (i + name.length < chars.length && IDENT.test(chars[i + name.length])) continue;
    n++;
  }
  return Math.max(n, 1);
}

// One line's inline Markdown as spans: `code` and **bold** lose their marks and keep their look.
function spans(text, bold = false) {
  const out = [];
  // A shields.io review badge (`![imo](https://img.shields.io/badge/review-imo-yellow.svg)`) becomes a label.
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|!\[([\w-]+)\]\(https:\/\/img\.shields\.io\/badge\/[^)\s]*\)/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), bold });
    if (m[4] != null) out.push({ text: ` ${m[4]} `, badge: m[4] });
    else if (m[1] != null) out.push({ text: m[1], bold, code: true }); else out.push({ text: m[2] ?? m[3], bold: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), bold });
  return out;
}

// Spans broken into lines no wider than `width`; lines after the first start `hang` px in.
// A line of code broken into pieces no wider than `width` px, at character boundaries
// (code has no spaces to wait for). Always at least one piece, so an empty line keeps its row.
function wrapCode(text, width) {
  const out = [];
  let part = "", used = 0;
  for (const ch of text) {
    const w = charW(ch);
    if (used + w > width && part) { out.push(part); part = ""; used = 0; }
    part += ch;
    used += w;
  }
  out.push(part);
  return out;
}

function wrapSpans(list, width, hang = 0) {
  const lines = [[]];
  let used = 0;
  for (const span of list) {
    let part = "";
    const flush = () => { if (part) { lines.at(-1).push({ ...span, text: part }); part = ""; } };
    for (const ch of span.text) {
      const w = charW(ch);
      if (used + w > width - (lines.length > 1 ? hang : 0) && (used > 0)) { flush(); lines.push([]); used = 0; }
      part += ch;
      used += w;
    }
    flush();
  }
  return lines;
}

/** A comment's Markdown as the lines to draw: `{ kind: "text" | "quote" | "code", indent, spans }`. */
function formatComment(text, width) {
  const out = [];
  let fenced = false;
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    if (/^\s*```/.test(raw)) { fenced = !fenced; continue; }
    if (fenced) { for (const line of wrapSpans([{ text: raw || " " }], width - 12)) out.push({ kind: "code", indent: 0, spans: line }); continue; }
    const quote = /^\s*>\s?/.exec(raw);
    const body = quote ? raw.slice(quote[0].length) : raw;
    const kind = quote ? "quote" : "text";
    const room = width - (quote ? QUOTE_PAD : 0);
    const heading = /^#{1,6}\s+/.exec(body);
    const item = /^(\s*)([-*+]|\d+[.)])\s+/.exec(body);
    if (heading) { for (const line of wrapSpans(spans(body.slice(heading[0].length), true), room)) out.push({ kind, indent: 0, spans: line }); continue; }
    if (item) {
      const lead = `${item[1]}${/\d/.test(item[2]) ? item[2] : L("・", "•")} `;
      const hang = [...lead].reduce((n, ch) => n + charW(ch), 0);
      wrapSpans([{ text: lead }, ...spans(body.slice(item[0].length))], room, hang).forEach((line, k) => out.push({ kind, indent: k ? hang : 0, spans: line }));
      continue;
    }
    for (const line of wrapSpans(spans(body), room)) out.push({ kind, indent: 0, spans: line });
  }
  return out.length > COMMENT_MAX_LINES ? [...out.slice(0, COMMENT_MAX_LINES), { kind: "text", indent: 0, spans: [{ text: L("…（続きは GitHub で見てください）", "… (the rest is on GitHub)") }] }] : out;
}

const load = (key, fallback) => JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
const stop = (_e, cx) => cx.stop_propagation();
// Text as GitHub shows it: template comments are left out (and would otherwise swallow what follows them).
const shownText = (text, max) => text.replace(/<!--[\s\S]*?-->/g, "").trim().slice(0, max);

function ago(iso) {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return min < 60 ? L(`${min}分前`, `${min}m ago`) : min < 1440 ? L(`${Math.round(min / 60)}時間前`, `${Math.round(min / 60)}h ago`) : L(`${Math.round(min / 1440)}日前`, `${Math.round(min / 1440)}d ago`);
}

// A pull request's checks, review decision and labels, as GitHub words them.
const ciOf = (pr) => ({
  SUCCESS: ["check", L("チェック成功", "Checks passed"), "ansi2"], FAILURE: ["x", L("チェック失敗", "Checks failed"), "ansi1"], ERROR: ["x", L("チェックエラー", "Checks errored"), "ansi1"],
  PENDING: ["circle-dot", L("チェック実行中", "Checks running"), "ansi3"], EXPECTED: ["circle-dot", L("チェック待ち", "Checks expected"), "ansi3"],
})[pr.ci] ?? ["circle-help", L("チェックなし", "No checks"), "dim"];
const failing = (pr) => pr.ci === "FAILURE" || pr.ci === "ERROR";
const decisionOf = (pr) => ({
  APPROVED: [L("承認済み", "Approved"), "ansi2"], CHANGES_REQUESTED: [L("修正の依頼", "Changes requested"), "ansi1"], REVIEW_REQUIRED: [L("レビュー待ち", "Review required"), "ansi3"],
})[pr.decision] ?? null;

// What each column of the code view keeps for itself (the view can show two files side by side).
// `this.<field>` reads and writes the column in use (`this.colAt`); see init() and inCol().
const COL_FIELDS = ["code", "codeAt", "codeBusy", "codeNote", "codeScroll", "codePlain", "codeH", "mark", "markAt", "markWord",
  "candidates", "back", "forward", "findOpen", "findInput", "findHits", "findAt", "findKey"];

export default class PrReview extends View {
  init(_props, cx) {
    this.cols = [this.newCol()];
    this.colAt = 0;
    for (const f of COL_FIELDS) Object.defineProperty(this, f, { configurable: true, get: () => this.cols[this.colAt][f], set: (v) => { this.cols[this.colAt][f] = v; } });
    this.role = props()?.role ?? "main";
    // The language: the one picked on the main screen (kept there), else the Mac's. Both roles follow it.
    this.lang = this.role === "main" ? load("lang", "auto") : "auto";
    if (this.lang !== "auto") setLang(this.lang);
    else if (!checking()) cx.spawn(async (cx) => { setLang(await macLang()); cx.notify(); });
    if (this.role !== "main") return;
    this.lists = load("lists", { requested: [], mine: [] });
    this.totals = {};
    this.tab = load("tab", "requested");
    // The order within each group ("priority" was an order of its own before groups were always there).
    this.sort = SORTS.some((x) => x.id === load("sort", "updated")) ? load("sort", "updated") : "updated";
    this.showBots = load("bots", false);
    // Folders folded in the file tree, by path.
    this.folded = new Set();
    // Your own tabs and questions, from data/pr-review/config.json (see readConfig).
    this.config = { tabs: [], prompts: null };
    this.configError = null;
    // The files you marked Viewed on GitHub, for the pull request shown: `{ url, id, viewed: Set }`.
    this.viewedOn = null;
    this.askInput = InputState.new({ placeholder: "" });
    this.askInput.on("submit", (_e, cx) => { const text = this.askInput.value().trim(); if (text) { this.askInput.set_value(""); this.ask({ label: text, ask: text }, cx); } cx.notify(); });
    this.widths = { list: PANES.list.start, files: PANES.files.start, side: PANES.side.start, ...load("widths", {}) };
    this.drag = null;
    // The diff shows one file at a time, in one column or with before and after side by side.
    this.file = null;
    this.split = load("split", false);
    this.drafts = load("drafts", {});
    this.listError = null;
    this.loading = false;
    this.listAt = null;
    this.side = null;
    this.askOpen = false;
    this.open = { body: true };
    this.picked = null;
    this.detail = null;
    this.files = [];
    this.rows = [];
    this.sizes = [];
    this.width = 300;
    this.note = null;
    this.diffBusy = false;
    this.compose = null;
    this.confirm = null;
    this.sending = false;
    this.sendError = null;
    this.threads = new Map();
    // Resolved threads are folded; these (their first comments' ids) were opened.
    this.openResolved = new Set();
    // The code view: one file at the pull request's head, selectable, with the places jumped from and back to.
    this.view = "diff";
    this.code = null;
    this.codeBusy = false;
    // The preview of a Markdown file (preview.js).
    this.preview = null;
    this.codeNote = null;
    this.back = [];
    this.forward = [];
    this.candidates = null;
    this.diffScroll = VirtualListScrollHandle.new();
    this.plainScroll = ScrollHandle.new();
    // Text selected by dragging over the lines of the diff or the code (Cmd+C copies it):
    // `{ key, side, a: { row, col }, b: { row, col }, active }`, see selKey().
    this.sel = null;
    this.selDone = false;
    // `git blame` of lines looked at in the code view, by "<head sha>|<path>|<line>".
    this.blames = new Map();
    // The search bar over the code or the diff (Cmd+F or Ctrl+F): what it found, the lines in order, and which one is shown.
    // (Each column has its own: see newCol().)
    // The keyboard for Cmd+C: the screen takes it when text is selected (an input keeps its own).
    this.selFocus = cx.focus_handle();
    this.hoverRow = null;
    // The row of the diff last clicked: where the code opens, and where Ctrl+- comes back to.
    this.diffAt = null;
    this.drag = null;
    this.dragged = false;
    this.codeAt = 0;
    this.pressX = null;
    this.pressW = null;
    // The name whose every use in the diff is marked (right-click a name to set it).
    this.mark = null;
    this.markAt = -1;
    // Narrows the list shown: words match the title, number, repository or author; a few
    // GitHub-like terms narrow by state (see matches()).
    this.search = InputState.new({ placeholder: "" });
    this.search.on("change", (_e, cx) => cx.notify());
    const writing = { language: "markdown", line_numbers: false, folding: false, soft_wrap: true, font_size: 12.5, value: "" };
    this.editor = EditorState.new(writing);
    this.editor.on("submit", (_e, cx) => this.saveDraft(cx));
    this.reviewBody = EditorState.new(writing);
    this.relate();
    this.count();
    // A check loads the mod for real: it must not call GitHub.
    if (checking()) return;
    cx.timer.every(LIST_MS, (cx) => this.readLists(cx));
    this.readConfig(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        // A command that fails says so, and the keys keep working: an exception here would end the
        // loop, and every key after it would do nothing without a word.
        try { this.command(c, cx); } catch (e) { notify({ title: L(`レビュー画面の「${c}」が失敗しました`, `The review screen's "${c}" failed`), body: String(e?.message ?? e).slice(0, 200), level: "warning" }); }
        cx.notify();
      }
    });
    this.readLists(cx);
  }

  // Keys (keys.json, `pr-review.<command>`) and `herdr-app do` reach the screen through here.
  command(c, cx) {
    if (c === "refresh") this.readLists(cx);
    else if (c === "code") this.toggleCode(cx);
    else if (c.startsWith("widen-") && this.compose) {
      // `widen-<line>`: what Shift and the + of that line do, for scripts.
      const row = this.current()?.rows.find((r) => r.line === Number(c.slice(6)) && r.side === this.compose.side);
      if (row) { this.pressShift = true; this.plusPressed(row); this.pressShift = false; }
    }
    else if (c === "mark-next" || c === "mark-prev") this.stepMark(c === "mark-next" ? 1 : -1);
    else if (c.startsWith("mark-")) { const n = c.slice(5); this.mark = n === "clear" ? null : n; this.markAt = -1; }
    else if (c === "reply") {
      // Answers the comment last jumped to (`next-comment`), else the first one in the shown file.
      const row = this.rows[this.jumped]?.kind === "thread" ? this.rows[this.jumped] : this.rows.find((r) => r.kind === "thread");
      if (row) this.startReply(row);
    } else if (c.startsWith("say-") && this.compose) this.editor.set_value(c.slice(4));
    else if (c === "draft-save") this.saveDraft(cx);
    else if (c === "draft-cancel") { this.compose = null; this.composeNote = null; }
    else if (c === "draft-drop-last" && this.draftsOf().length) this.dropDraft(this.draftsOf().length - 1);
    else if (c === "definition") this.goDefinition(cx);
    else if (c === "back") this.goBack(cx);
    else if (c === "forward") this.goForward(cx);
    else if (c.startsWith("select-") && this.code) {
      // `select-<name>`: marks the name and makes its first use the current line, for scripts (people click).
      const name = c.slice(7).replace(/[^A-Za-z0-9_$]/g, "");
      const re = new RegExp(`(?<![A-Za-z0-9_$])${name.replace(/\$/g, "\\$")}(?![A-Za-z0-9_$])`);
      const at = this.code.rows.findIndex((r) => re.test(r.text));
      if (at >= 0) { this.mark = name; this.codeAt = at; this.scrollCode(at, "center", cx); }
    } else if (c === "next" || c === "prev") {
      const prs = this.shown();
      const to = prs[prs.findIndex((pr) => pr.url === this.picked?.url) + (c === "next" ? 1 : -1)];
      if (to) this.pick(to, cx);
    } else if (c === "info" || c === "send") this.side = this.side === c ? null : c;
    else if (c === "ask") this.pressAsk();
    else if (c === "sort") this.setSort(SORTS[(SORTS.findIndex((s) => s.id === this.sort) + 1) % SORTS.length].id);
    else if (c.startsWith("open-")) {
      // `open-<number>`: the loaded pull request of that number.
      const pr = [...this.all.values()].find((x) => String(x.number) === c.slice(5));
      if (pr) this.pick(pr, cx);
    } else if (c === "next-comment") {
      // The next inline comment below the last one jumped to.
      const from = (this.jumped ?? -1) + 1;
      let at = this.rows.findIndex((r, i) => i >= from && (r.kind === "thread" || r.kind === "draft"));
      if (at < 0) at = this.rows.findIndex((r) => r.kind === "thread" || r.kind === "draft");
      if (at >= 0) { this.jumped = at; this.scrollDiff(at); }
    }
    else if (c.startsWith("tab-")) this.setTab(c.slice(4));
    else if (/^lang-(ja|en|auto)$/.test(c)) this.setLanguage(c.slice(5), cx);
    else if (c === "config") this.readConfig(cx);
    else if (c === "viewed" && this.current()) this.toggleViewed(this.current(), cx);
    else if (c === "split") this.setSplit(!this.split);
    else if (c === "preview") { if (previewKind(this.current())) { togglePreview(this); this.compose = null; } }
    // `preview-line-12`: in the preview, what line 12 of the file shows, as if it were pressed.
    else if (c.startsWith("preview-line-")) pickLine(this, Number(c.slice(13)));
    else if (c === "copy") this.copySel(cx);
    else if (c === "references") this.goReferences(cx);
    // `search-<text>`: as typing <text> in the search box (for scripts).
    else if (c.startsWith("search-")) this.search.set_value(c.slice(7));
    else if (c === "find") { if (this.picked) this.openFind(); }
    else if (c.startsWith("find-")) { if (!this.findOpen) this.openFind(); this.findInput.set_value(c.slice(5)); this.runFind(cx); }
    else if (c === "next-file" || c === "prev-file") this.stepFile(c === "next-file" ? 1 : -1);
    else if (/^width-(list|files|side)-(\d+|reset)$/.test(c)) {
      // `width-files-320`, `width-list-reset`: one pane's width in px, or back to its usual one.
      const [, pane, to] = c.split("-");
      this.widths[pane] = to === "reset" ? PANES[pane].start : Math.max(PANES[pane].min, Math.min(PANES[pane].max, Number(to)));
      save("widths", this.widths);
    }
    else if (c === "comment") {
      const at = this.rows.find((r) => r.kind === "+" || r.kind === "-");
      if (at) this.startDraft(at);
    }
  }

  // ---- the lists -----------------------------------------------------------

  // Every tab: the two that are always there, then yours from config.json.
  tabs() {
    return [...TABS, ...this.config.tabs.map((x, i) => ({ id: `my-${i}`, label: () => x.name, query: x.query }))];
  }
  setTab(id) { if (this.tabs().some((t) => t.id === id)) { this.tab = id; save("tab", id); } }
  setSort(id) { this.sort = id; save("sort", id); }

  // The language: "ja", "en", or "auto" (the Mac's). Kept for the next start.
  setLanguage(to, cx) {
    this.lang = to;
    save("lang", to);
    if (to !== "auto") { setLang(to); return; }
    cx.spawn(async (cx) => { setLang(await macLang()); cx.notify(); });
  }

  // Your own tabs and questions: data/pr-review/config.json, read at start and on `config`.
  //   { "tabs": [{ "name": "Team", "query": "repo:owner/name" }],
  //     "prompts": [{ "label": "Security", "ask": "Look for ..." }] }
  // A tab's query is GitHub search (`is:pr is:open` is added). With prompts of your own, they
  // replace the two the screen offers.
  readConfig(cx) {
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(`${appHome()}/data/pr-review/config.json`);
        const c = text ? JSON.parse(text) : {};
        const tabs = (Array.isArray(c.tabs) ? c.tabs : []).filter((x) => typeof x?.name === "string" && typeof x?.query === "string" && x.query.trim());
        const prompts = (Array.isArray(c.prompts) ? c.prompts : []).filter((x) => typeof x?.label === "string" && typeof x?.ask === "string");
        this.config = { tabs, prompts: prompts.length ? prompts : null };
        this.configError = null;
      } catch (e) {
        this.configError = `data/pr-review/config.json: ${String(e?.message ?? e)}`;
      }
      if (!this.tabs().some((t) => t.id === this.tab)) this.tab = "requested";
      this.readLists(cx);
      cx.notify();
    });
  }

  // The bar shows how many wait for you: people's pull requests asking for your review.
  count() {
    setShared("pr-review.count", this.lists.requested.filter((pr) => !pr.bot && !pr.draft).length);
  }

  // Which pull request another one is stacked on, and how deep, among everything loaded.
  relate() {
    this.all = new Map(Object.values(this.lists).flat().map((pr) => [pr.url, pr]));
    this.requested = new Set(this.lists.requested.map((pr) => pr.url));
    const byHead = new Map([...this.all.values()].map((pr) => [`${pr.repo}\n${pr.head}`, pr]));
    this.parent = new Map();
    for (const pr of this.all.values()) {
      const on = pr.base === pr.defaultBranch ? null : byHead.get(`${pr.repo}\n${pr.base}`);
      if (on && on.url !== pr.url) this.parent.set(pr.url, on);
    }
    this.depth = (pr) => { let d = 0; for (let at = this.parent.get(pr.url); at && d < 20; at = this.parent.get(at.url)) d++; return d; };
  }

  // What to do with a pull request now, and why: [group id, reason].
  triage(pr) {
    if (pr.mine) {
      if (pr.draft) return ["watch", L("自分の Draft", "your draft")];
      if (failing(pr)) return ["act", L("自分の PR のチェックが失敗している", "your pull request's checks failed")];
      if (pr.decision === "CHANGES_REQUESTED") return ["act", L("修正を求められている", "changes were requested")];
      if (pr.decision === "APPROVED") return ["act", L("承認済み。マージできる", "approved, ready to merge")];
      return ["wait", L("レビュー待ち", "waiting for review")];
    }
    if (this.requested.has(pr.url)) {
      if (pr.draft) return ["watch", L("レビュー依頼はあるが Draft", "review requested, but a draft")];
      if (pr.bot) return ["watch", L("Bot が作った PR", "opened by a bot")];
      if (failing(pr)) return ["wait", L("チェックが失敗している（作者の修正待ち）", "checks failed (the author fixes first)")];
      return ["read", pr.decision === "APPROVED" ? L("レビュー依頼あり（ほかの人は承認済み）", "review requested (others approved)") : this.parent.has(pr.url) ? L("レビュー依頼あり（ベースの PR を先に読む）", "review requested (read its base first)") : L("レビュー依頼あり", "review requested")];
    }
    if (pr.myReview) return pr.pushedAt > pr.myReview.at ? ["read", L("自分のレビュー後に更新された", "updated since your review")] : ["wait", L("レビュー済み。作者の対応待ち", "reviewed, waiting for the author")];
    return ["watch", L("自分への依頼なし", "no request for you")];
  }

  // Whether a pull request matches the search box. Words match the title, number, repository or
  // author; these terms narrow by state: review:required|approved|changes, is:draft, ci:failing|passing,
  // author:<login>, repo:<name>.
  matches(pr, query) {
    for (const word of query.toLowerCase().split(/\s+/).filter(Boolean)) {
      const [key, value] = word.includes(":") ? [word.slice(0, word.indexOf(":")), word.slice(word.indexOf(":") + 1)] : [null, word.replace(/^#/, "")];
      const ok = key === "review" ? ({ required: "REVIEW_REQUIRED", approved: "APPROVED", changes: "CHANGES_REQUESTED" })[value] === pr.decision
        : key === "is" ? (value === "draft" ? pr.draft : value === "open" ? true : false)
        : key === "ci" ? (value === "failing" ? failing(pr) : value === "passing" ? pr.ci === "SUCCESS" : false)
        : key === "author" ? pr.author.toLowerCase() === value.replace(/^@/, "")
        : key === "repo" ? pr.repo.toLowerCase().includes(value)
        : `${pr.title}\n${pr.number}\n${pr.repo}\n${pr.author}`.toLowerCase().includes(key ? word : value);
      if (!ok) return false;
    }
    return true;
  }

  // The tab's pull requests that the search box and the bots switch let through, in the chosen order.
  shown() {
    const q = this.search.value().trim();
    const by = {
      updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
      new: (a, b) => b.createdAt.localeCompare(a.createdAt),
      old: (a, b) => a.createdAt.localeCompare(b.createdAt),
    };
    return (this.lists[this.tab] ?? []).filter((pr) => (this.showBots || !pr.bot) && (!q || this.matches(pr, q))).sort(by[this.sort] ?? by.updated);
  }

  // The list as drawn: group by group, each group in the chosen order, a stacked pull request right
  // under the one it builds on when both are in the group (`depth` is how far in it is set).
  // Elsewhere it stands on its own and says its base.
  groups() {
    const prs = this.shown();
    return GROUPS.map((g) => {
      const mine = prs.filter((pr) => this.triage(pr)[0] === g.id);
      const here = new Set(mine.map((pr) => pr.url));
      const kids = new Map();
      for (const pr of mine) { const on = this.parent.get(pr.url); if (on && here.has(on.url)) kids.set(on.url, [...(kids.get(on.url) ?? []), pr]); }
      const out = [];
      const walk = (pr, depth) => { out.push({ pr, depth }); for (const k of kids.get(pr.url) ?? []) walk(k, depth + 1); };
      for (const pr of mine) if (!(this.parent.get(pr.url) && here.has(this.parent.get(pr.url).url))) walk(pr, 0);
      return { g, rows: out };
    }).filter((x) => x.rows.length);
  }

  readLists(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      // The Slack threads of the first-pass reviews: a local file, so it never holds the lists up.
      slackThreads().then((map) => { this.threads = map; cx.notify(); }, () => {});
      try {
        const tabs = this.tabs();
        const found = await Promise.all(tabs.map((t) => searchPrs(t.query, t.id.startsWith("my-") ? TAB_LIMIT : 100)));
        this.lists = Object.fromEntries(tabs.map((t, i) => [t.id, found[i].prs]));
        this.totals = Object.fromEntries(tabs.map((t, i) => [t.id, found[i].total]));
        this.listError = null;
        this.relate();
        this.count();
        // The picked one may have been merged meanwhile; otherwise it follows its new state.
        if (this.picked) this.picked = this.all.get(this.picked.url) ?? this.picked;
        if (!this.picked && this.shown().length) this.pick(this.groups()[0].rows[0].pr, cx);
        this.listAt = Date.now();
        save("lists", this.lists);
      } catch (e) {
        this.listError = String(e?.message ?? e);
      }
      this.loading = false;
      cx.notify();
    });
  }

  // ---- one pull request ----------------------------------------------------

  // A column of the code view, empty: its file, place, marks, uses, history and search.
  newCol() {
    const col = { code: null, codeAt: 0, codeBusy: false, codeNote: null, codeScroll: VirtualListScrollHandle.new(), codePlain: ScrollHandle.new(),
      codeH: null, mark: null, markAt: -1, markWord: null, candidates: null, back: [], forward: [],
      findOpen: false, findHits: [], findAt: -1, findKey: null, findInput: InputState.new({ placeholder: "" }) };
    // Typing in a column's search box searches that column, whichever was in use before.
    col.findInput.on("change", (_e, cx) => { this.inCol(col, () => this.runFind(cx)); cx.notify(); });
    col.findInput.on("submit", (e, cx) => { this.inCol(col, () => this.stepFind(e?.shift ? -1 : 1, cx)); cx.notify(); });
    return col;
  }

  // Runs `fn` with `col` as the column in use, then puts the one in use back: work that finishes
  // later (a file read, a lookup) lands in the column that asked for it. Nothing when it was closed.
  inCol(col, fn) {
    const at = this.cols.indexOf(col);
    if (at < 0) return undefined;
    const before = this.colAt;
    this.colAt = at;
    try { return fn(); } finally { this.colAt = Math.min(before, this.cols.length - 1); }
  }

  // Makes column `k` the one in use (a press in it); a selection in the other one is let go.
  useCol(k) {
    if (this.colAt === k || !this.cols[k]) return;
    this.colAt = k;
    if (this.sel?.side === "code") this.sel = null;
  }

  // Cmd+click on a file in the code view: it opens in a second column on the right (made the first time).
  openSide(path, cx) {
    if (this.cols.length < 2) this.cols.push(this.newCol());
    this.useCol(1);
    this.back = []; this.forward = []; this.candidates = null;
    this.openCode(path, cx);
  }

  closeSide() {
    if (this.cols.length < 2) return;
    this.cols.length = 1;
    this.colAt = 0;
    if (this.sel?.side === "code") this.sel = null;
  }

  pick(pr, cx) {
    this.cols = [this.newCol()];
    this.colAt = 0;
    this.picked = pr;
    this.view = "diff";
    this.diffAt = null;
    this.mark = null;
    this.code = null;
    this.codeNote = null;
    this.back = [];
    this.forward = [];
    this.candidates = null;
    this.detail = null;
    this.openResolved = new Set();
    this.files = [];
    this.file = null;
    this.note = null;
    this.viewedOn = null;
    this.compose = null;
    this.confirm = null;
    this.sendError = null;
    this.diffBusy = true;
    this.rebuild();
    cx.notify();
    cx.spawn(async (cx) => {
      const still = () => this.picked?.url === pr.url;
      // The details and the diff arrive separately: one failing leaves the other.
      prDetail(pr).then((detail) => {
        if (!still()) return;
        this.detail = detail;
        this.rebuild();
        cx.notify();
      }, (e) => { if (still()) { this.note = String(e?.message ?? e); cx.notify(); } });
      // GitHub's Viewed marks come with the diff, so the first file shown is the first one not viewed.
      const viewed = viewedFiles(pr).then((v) => v, (e) => ({ error: String(e?.message ?? e) }));
      try {
        const diff = await prDiff(pr, (text) => { if (still()) { this.note = text; cx.notify(); } });
        if (!still()) return;
        const v = await viewed;
        if (!still()) return;
        this.viewedOn = v.error ? null : { url: pr.url, id: v.id, viewed: v.viewed };
        const lines = diff.split("\n");
        this.files = parseDiff(lines.length > MAX_LINES ? lines.slice(0, MAX_LINES).join("\n") : diff).files;
        this.note = [
          lines.length > MAX_LINES ? L(`差分が長いため、先頭 ${MAX_LINES.toLocaleString()} 行までを表示しています。続きは GitHub で見てください。`, `The diff is long: its first ${MAX_LINES.toLocaleString()} lines are shown. The rest is on GitHub.`) : null,
          v.error ? `${L("Viewed の印を GitHub から読めませんでした", "Could not read the Viewed marks from GitHub")}: ${v.error}` : null,
        ].filter(Boolean).join("\n") || null;
        this.file = (this.files.find((f) => !this.isViewed(f)) ?? this.files[0])?.path ?? null;
        this.rebuild();
      } catch (e) {
        if (still()) this.note = String(e?.message ?? e);
      }
      if (still()) { this.diffBusy = false; cx.notify(); }
    });
  }

  // ---- the code view --------------------------------------------------------

  // Between the diff and the code, at the same place: the code opens on the file and line the diff
  // shows (the line last clicked), and the diff opens on the file and line the code shows, when
  // that file is in the pull request and the line is in its diff (else the nearest line that is).
  toggleCode(cx) {
    if (!this.picked) return;
    if (this.view === "code") {
      this.view = "diff";
      const path = this.code?.path;
      if (path && this.files.some((f) => f.path === path)) {
        if (path !== this.current()?.path) { this.file = path; this.compose = null; this.rebuild(); }
        const at = this.rowOfHeadLine(this.codeAt + 1);
        if (at >= 0) { this.diffAt = at; this.scrollDiff(at); }
      }
      return;
    }
    this.compose = null;
    const file = this.current();
    if (!file) return;
    const line = this.headLineOf(this.diffHere());
    if (this.code?.path === file.path && line == null) { this.view = "code"; return; }
    this.openCode(file.path, cx, { line });
  }

  // The row of the diff you are at: the one last clicked, else the marked name's, else the first
  // (whose head line is the file's first changed line).
  diffHere() {
    return this.diffAt ?? (this.markAt >= 0 ? this.markAt : 0);
  }

  // The line at the head commit a row of the diff stands for (an added or unchanged line), or null.
  rightLine(r) {
    if (!r) return null;
    if (r.kind === "pair") return r.right?.side === "RIGHT" ? r.right.line : null;
    return r.side === "RIGHT" && r.line != null ? r.line : null;
  }

  // The head line at row `i` of the diff: that row's, else the next row's that has one (a removed
  // line stands where the line after it is now), else the one before. Null without a row.
  headLineOf(i) {
    if (i == null) return null;
    for (let j = i; j < this.rows.length; j++) { const l = this.rightLine(this.rows[j]); if (l != null) return l; }
    for (let j = i - 1; j >= 0; j--) { const l = this.rightLine(this.rows[j]); if (l != null) return l; }
    return null;
  }

  // The row of the diff showing head line `n`, or the one nearest to it; -1 when no row has a head line.
  rowOfHeadLine(n) {
    let best = -1, gap = Infinity;
    this.rows.forEach((r, i) => { const l = this.rightLine(r); if (l != null && Math.abs(l - n) < gap) { best = i; gap = Math.abs(l - n); } });
    return best;
  }

  // Opens one file of the pull request (at its head commit) in the code view, colored line by line.
  // `line` (from 1) is put in the middle and becomes the current line; `name` is marked.
  openCode(path, cx, { line = null, name = null } = {}) {
    const pr = this.picked;
    const col = this.cols[this.colAt];
    this.view = "code";
    this.codeBusy = true;
    this.codeNote = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const still = () => this.picked?.url === pr.url && this.cols.includes(col);
      let raw = null, failed = null;
      try { raw = await fileAt(pr, path); } catch (err) { failed = err; }
      if (!still()) return;
      this.inCol(col, () => this.showCode(path, raw, failed, { line, name }, cx));
      cx.notify();
    });
  }

  // The file read for the column in use goes on screen, at `line`, with `name` marked.
  showCode(path, raw, failed, { line, name }, cx) {
    {
      try {
        if (failed) throw failed;
        if (raw.includes("\0")) throw new Error(L("バイナリのファイルは表示できません。", "A binary file can't be shown."));
        const text = raw.length > MAX_CODE ? `${raw.slice(0, MAX_CODE)}\n${L("…（長いファイルのため、ここまでを表示しています）", "… (a long file: shown up to here)")}` : raw;
        const lang = languageOf(path);
        let state = null, widest = 0;
        const rows = text.replace(/\n$/, "").split("\n").map((l) => {
          const line = untabLine(l);
          widest = Math.max(widest, line.length);
          if (!lang) return { text: line, segs: [{ text: line, kind: null }] };
          const h = highlightLine(line, lang, state);
          state = h.state;
          return { text: line, segs: h.segs };
        });
        this.code = { path, rows, width: Math.max(300, (widest + 1) * HIT_W + 80) };
        if (name) this.mark = name;
        this.codeAt = line != null ? Math.min(rows.length - 1, Math.max(0, line - 1)) : 0;
        this.scrollCode(this.codeAt, line != null ? "center" : "top", cx);
        if (line != null) this.ensureBlame(cx);
      } catch (err) {
        this.codeNote = String(err?.message ?? err);
      }
      this.codeBusy = false;
    }
  }

  // Where you are now, to come back to: in the code, the file, the current line and the marked name;
  // in the diff, the file, the row last clicked and the marked name.
  place() {
    if (this.view !== "code") { const f = this.current(); return f ? { view: "diff", file: f.path, row: this.diffHere(), mark: this.mark } : null; }
    return this.code ? { view: "code", path: this.code.path, line: this.codeAt + 1, mark: this.mark } : null;
  }

  // Goes to a place `place()` gave.
  goTo(to, cx) {
    this.candidates = null;
    if (to.view !== "diff") { this.openCode(to.path, cx, { line: to.line, name: to.mark }); return; }
    this.view = "diff";
    if (to.file !== this.current()?.path && this.files.some((f) => f.path === to.file)) { this.file = to.file; this.compose = null; this.rebuild(); }
    this.mark = to.mark;
    this.diffAt = Math.max(0, Math.min(to.row, this.rows.length - 1));
    this.scrollDiff(this.diffAt);
  }

  // A click on a line of code makes it the current line and marks the name under the pointer.
  pressCode(i) {
    const row = this.code?.rows[i];
    if (!row) return;
    this.codeAt = i;
    const word = this.pressX == null ? null : wordAtX(row.text, this.pressX - CODE_X0);
    const name = word?.name ?? null;
    this.markWord = word && { ...word, nth: placeOf(row.text, name, word.start) };
    this.mark = name;
    this.markAt = -1;
  }

  // F12: to where the marked name (click a name to mark it) is defined, from the code or the diff.
  // From the diff without a marked name, the code of the line last clicked opens. Either way the
  // place left is kept, so Ctrl+- comes back to it -- to the diff too.
  goDefinition(cx) {
    const pr = this.picked;
    if (!pr) return;
    const inDiff = this.view !== "code";
    const fromPath = inDiff ? this.current()?.path : this.code?.path;
    if (!fromPath) { if (!inDiff) this.codeNote = L("左のファイル一覧から、開くファイルを選んでください。", "Pick a file to open in the list on the left."); return; }
    const from = this.place();
    const here = inDiff ? this.headLineOf(this.diffHere()) : from.line;
    const name = this.mark;
    if (!name) {
      if (!inDiff) { this.codeNote = L("名前をクリックしてハイライトしてから、F12 を押してください。", "Click a name to highlight it, then press F12."); return; }
      this.back.push(from);
      this.forward = [];
      this.candidates = null;
      this.openCode(fromPath, cx, { line: here });
      return;
    }
    // Said where you are: the code view shows its own note, the diff a notification.
    // The answer lands in the column F12 was pressed in.
    const col = this.cols[this.colAt];
    const say = (text) => { if (inDiff) notify({ title: L("定義へ移れません", "Can't go to the definition"), body: text, level: "info" }); else col.codeNote = text; };
    this.codeBusy = true;
    this.codeNote = null;
    cx.notify();
    const word = this.markWord?.name === name ? this.markWord : null;
    const token = this.defToken = (this.defToken ?? 0) + 1;
    const mine = () => this.picked?.url === pr.url && this.defToken === token && this.cols.includes(col);
    const go = (d, candidates = null) => this.inCol(col, () => {
      this.back.push(from);
      this.forward = [];
      this.candidates = candidates;
      this.openCode(d.path, cx, { line: d.line, name });
    });
    cx.spawn(async (cx) => {
      // Go: gopls says by type where the name is defined. Only when it can't (not installed, the
      // code doesn't load) does the search by spelling below stand in, and that is said.
      let why = null;
      if (/\.go$/.test(fromPath)) {
        try {
          const d = await goplsDefinition(pr, name, fromPath, here, word?.nth ?? 1);
          if (!mine()) return;
          if (!d) say(L(`「${name}」の定義は、このリポジトリの外（標準ライブラリかモジュール）にあります。`, `${name} is defined outside this repository (the standard library or a module).`));
          else if (d.path === fromPath && d.line === here) say(L(`「${name}」の定義はここです。`, `${name} is defined here.`));
          else { go(d); return; }
          col.codeBusy = false;
          cx.notify();
          return;
        } catch (err) {
          if (!mine()) return;
          why = String(err?.message ?? err);
        }
      }
      try {
        // A name clicked right after a `.` is a member: no variable of a function is what it means.
        const member = Boolean(word?.member);
        const all = await definitions(pr, name, fromPath, { member });
        // The definition the current line already is, is not a place to go.
        const defs = all.filter((d) => !(d.path === fromPath && d.line === here));
        if (!mine()) return;
        if (why) notify({ title: L("定義を型で確かめられませんでした（名前の検索で移ります）", "Could not find the definition by type (going by the name's spelling)"), body: why, level: "warning" });
        if (!defs.length) say(all.length ? L(`「${name}」の定義はここです。`, `${name} is defined here.`) : L(`「${name}」の定義が、このリポジトリの中に見つかりません（外部のライブラリか、探し方に合わない書き方です）。`, `No definition of ${name} in this repository (an outside library, or written in a way the search doesn't know).`));
        else { go(defs[0], defs.length > 1 ? { name, defs, at: 0 } : null); return; }
      } catch (err) {
        say(String(err?.message ?? err));
      }
      col.codeBusy = false;
      cx.notify();
    });
  }

  // Shift+F12: to the places the marked name is used, from the code or the diff. The uses are listed
  // over the code (the nearest first) and the first one after where you are opens; pressing it again
  // goes on to the next use. The place left is kept, so Ctrl+- comes back to it.
  goReferences(cx) {
    const pr = this.picked;
    if (!pr) return;
    const inDiff = this.view !== "code";
    const col = this.cols[this.colAt];
    const say = (text) => { if (inDiff) notify({ title: L("参照へ移れません", "Can't go to the uses"), body: text, level: "info" }); else col.codeNote = text; };
    const name = this.mark;
    if (!name) { say(L("名前をクリックしてハイライトしてから、Shift+F12 を押してください。", "Click a name to highlight it, then press Shift+F12.")); return; }
    // Pressed again on the same name: the next use in the list.
    const c = this.candidates;
    if (!inDiff && c?.kind === "refs" && c.name === name && c.defs.length > 1) { this.pickCandidate((c.at + 1) % c.defs.length, cx); return; }
    const fromPath = inDiff ? this.current()?.path : this.code?.path;
    if (!fromPath) { say(L("左のファイル一覧から、開くファイルを選んでください。", "Pick a file to open in the list on the left.")); return; }
    const from = this.place();
    const here = inDiff ? this.headLineOf(this.diffHere()) : from.line;
    // For Go the quick list (the word, outside strings and comments) is checked by type with gopls
    // afterwards, and replaced by its answer; `token` keeps a late answer off a newer lookup.
    const byType = /\.go$/.test(fromPath);
    const token = this.refsToken = (this.refsToken ?? 0) + 1;
    const mine = () => this.picked?.url === pr.url && this.refsToken === token && this.cols.includes(col);
    const notHere = (d) => !(d.path === fromPath && d.line === here);
    // The first use after this line in this file, else the nearest one listed.
    const firstOf = (list) => { const next = list.findIndex((d) => d.path === fromPath && here != null && d.line > here); return next >= 0 ? next : 0; };
    const show = (list, at, extra) => {
      if (!this.candidates || this.candidates.token !== token) { this.back.push(from); this.forward = []; }
      this.candidates = { kind: "refs", token, name, defs: list, at, ...extra };
      this.openCode(list[at].path, cx, { line: list[at].line, name });
    };
    this.codeBusy = true;
    this.codeNote = null;
    cx.notify();
    const nth = this.markWord?.name === name ? this.markWord.nth ?? 1 : 1;
    // Each step after a wait runs in the column Shift+F12 was pressed in.
    cx.spawn(async (cx) => {
      let found = null, error = null;
      try { found = await references(pr, name, fromPath); } catch (err) { error = err; }
      if (!mine()) return;
      this.inCol(col, () => {
        let opened = false;
        if (error) say(String(error?.message ?? error));
        else {
          const { refs, total } = found;
          const others = refs.filter(notHere);
          if (others.length) { show(others, firstOf(others), { total: total - (refs.length - others.length), checking: byType }); opened = true; }
          else if (!byType) say(refs.length ? L(`「${name}」が使われているのは、ここだけです。`, `${name} is used only here.`) : L(`「${name}」が使われている箇所が、このリポジトリの中に見つかりません。`, `${name} is not used anywhere in this repository.`));
        }
        if (!opened) this.codeBusy = byType;
      });
      cx.notify();
      if (!byType) return;

      let failed = null;
      const precise = await goplsReferences(pr, name, fromPath, here, nth).catch((e) => { failed = String(e?.message ?? e); return null; });
      if (!mine()) return;
      this.inCol(col, () => this.typedRefs({ precise, failed, token, name, notHere, firstOf, show, say }));
      cx.notify();
    });
  }

  // gopls' answer to Shift+F12, for the column in use: it replaces the list by spelling when it can.
  typedRefs({ precise, failed, token, name, notHere, firstOf, show, say }) {
    {
      const c = this.candidates?.token === token ? this.candidates : null;
      if (!c) this.codeBusy = false;
      if (precise == null) {
        // gopls couldn't say (not installed, or the code doesn't load): the word search stands, and why is said.
        if (c) { c.checking = false; c.unchecked = true; c.why = failed; }
        notify({ title: c ? L("参照を型で確かめられませんでした（単語の検索のまま）", "Could not check the uses by type (the word search stands)") : L(`「${name}」の参照が見つかりません`, `No uses of ${name} found`), body: failed ?? "", level: "warning" });
        return;
      }
      const list = precise.filter(notHere);
      if (!list.length) {
        if (c) this.candidates = null;
        say(L(`型で調べると、「${name}」はほかで使われていません。`, `By type, ${name} is not used anywhere else.`));
      } else {
        // Staying on the use shown when gopls lists it too; else to its first.
        const cur = c?.defs[c.at];
        const at = cur ? list.findIndex((d) => d.path === cur.path && d.line === cur.line) : -1;
        if (at >= 0) this.candidates = { ...c, defs: list, at, total: list.length, checking: false, typed: true };
        else show(list, firstOf(list), { total: list.length, checking: false, typed: true });
      }
    }
  }

  // Another of the places a name is defined at, in place of the one shown.
  pickCandidate(i, cx) {
    const c = this.candidates;
    c.at = i;
    this.openCode(c.defs[i].path, cx, { line: c.defs[i].line, name: c.name });
  }

  goBack(cx) {
    const to = this.back.pop();
    if (!to) return;
    const here = this.place();
    if (here) this.forward.push(here);
    this.goTo(to, cx);
  }

  goForward(cx) {
    const to = this.forward.pop();
    if (!to) return;
    const here = this.place();
    if (here) this.back.push(here);
    this.goTo(to, cx);
  }

  // The code view: one column, or two side by side (Cmd+click a file). Each column is drawn with
  // itself in use, so what it shows is its own; a press in a column makes it the one in use.
  codePane(t) {
    if (this.cols.length < 2) return this.codeCol(t, 0);
    // A plain row, so the columns fill its height (h_flex would centre them and let them collapse).
    return div().flex().flex_row().flex_1().min_w(0).min_h(0)
      .child(this.inCol(this.cols[0], () => this.codeCol(t, 0)))
      .child(div().w(1).h_full().flex_none().bg(t.border))
      .child(this.inCol(this.cols[1], () => this.codeCol(t, 1)));
  }

  codeCol(t, k) {
    const c = this.code;
    const col = this.cols[k];
    const two = this.cols.length > 1;
    const lines = k ? `code-lines-${k}` : "code-lines";
    const button = (id, label, tip, on, onClick) => div().id(id).flex_none().px(8).h(22).flex().items_center().rounded(4).text_size(12)
      .text_color(on ? t.foreground : t.dim).when(on, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))).tooltip(tip).on_click(onClick).child(label);
    return v_flex().id(`code-col-${k}`).flex_1().min_w(0).min_h(0)
      // The press reaches here after the line under it has seen it, and before any click.
      .on_mouse_down("left", () => this.useCol(k))
      .child(h_flex().h(30).flex_none().px(8).gap(4).items_center().border_b(1).border_color(t.border).text_size(12)
        // With two columns, the one in use is underlined in the accent color: keys act on it.
        .when(two && this.colAt === k, (el) => el.border_b(2).border_color(t.accent))
        .child(button("code-back", L("戻る", "Back"), L("ジャンプする前の場所へ（Ctrl+-）", "Where you were before the jump (Ctrl+-)"), this.back.length > 0, (_e, cx) => { this.goBack(cx); cx.notify(); }))
        .child(button("code-forward", L("進む", "Forward"), L("戻る前の場所へ（Ctrl+Shift+-）", "Where you were before going back (Ctrl+Shift+-)"), this.forward.length > 0, (_e, cx) => { this.goForward(cx); cx.notify(); }))
        .child(div().flex_1().min_w(0).truncate().px(6).font_family(settings().font_family ?? "JetBrains Mono").text_color(t.foreground).child(c?.path ?? ""))
        .when(Boolean(this.mark), (el) => el.child(h_flex().flex_none().h(22).px(8).items_center().rounded(R.sm).bg(t.accent + "26").font_family(settings().font_family ?? "JetBrains Mono").text_color(t.foreground).child(this.mark)))
        .child(this.selChip(t))
        .when(!this.selRange(), (el) => el.child(div().flex_none().pr(8).text_color(t.dim).child(this.codeBusy ? L("読み込み中…", "Loading…") : (c?.rows.length ?? 0) <= PLAIN_MAX ? L("名前をクリックして F12 で定義へ・ドラッグで文字を選択", "Click a name, F12 for its definition · drag to select text") : L("名前をクリックして F12 で定義へ", "Click a name, F12 for its definition"))))
        .when(k === 1, (el) => el.child(div().id("code-col-close").flex_none().w(22).h(22).flex().items_center().justify_center().rounded(4).cursor_pointer().hover((s) => s.bg(t.hover))
          .tooltip(L("右の列を閉じる", "Close the right column")).on_click((_e, cx) => { cx.stop_propagation(); this.closeSide(); cx.notify(); }).child(ico("x", 12, t.muted)))))
      .when(this.findOpen, (el) => el.child(this.findBar(t, col)))
      .when(Boolean(this.candidates), (el) => el.child(h_flex().id("code-candidates").h(30).flex_none().px(8).gap(4).items_center().border_b(1).border_color(t.border).overflow_x_scrollbar().text_size(11)
        .child(div().flex_none().pr(4).text_color(t.muted).child(this.candidates.kind === "refs"
          ? `${L(`「${this.candidates.name}」の参照`, `Uses of ${this.candidates.name}`)} ${this.candidates.at + 1} / ${this.candidates.defs.length}${this.candidates.total > this.candidates.defs.length ? L(`（全 ${this.candidates.total} 件のうち近い順）`, ` (nearest of ${this.candidates.total})`) : ""} · ${this.candidates.typed ? L("型で確認済み", "checked by type") : this.candidates.checking ? L("単語で検索・gopls で型を確認中…", "by word · checking by type with gopls…") : this.candidates.unchecked ? L(`単語で検索（gopls で確かめられませんでした: ${this.candidates.why ?? "理由不明"}）`, `by word (gopls could not check: ${this.candidates.why ?? "unknown"})`) : L("単語で検索（文字列・コメントは除く）", "by word (strings and comments left out)")} · ${L("Shift+F12 で次へ", "Shift+F12 for the next")}:`
          : L(`「${this.candidates.name}」の定義の候補 ${this.candidates.defs.length} 件:`, `${this.candidates.defs.length} possible definitions of ${this.candidates.name}:`)))
        // A use reached across services says how: a call from another service through the gRPC client,
        // or the service's own method the call lands in.
        .children(this.candidates.defs.map((d, i) => h_flex().id(`cand-${i}`).flex_none().px(6).h(20).gap(4).items_center().rounded(4)
          .bg(i === this.candidates.at ? t.selected : t.surface).text_color(i === this.candidates.at ? t.foreground : t.muted)
          .cursor_pointer().hover((s) => s.bg(t.hover))
          .tooltip(`${d.path}:${d.line}\n${d.text}${d.via ? `\n${d.via.kind === "rpc" ? L(`${d.via.service} の gRPC クライアント経由で、別のサービスから呼んでいます`, `called from another service through ${d.via.service}'s gRPC client`) : L(`${d.via.service} のサーバー側の実装（gRPC の呼び出しが届く所）`, `${d.via.service}'s server method (where a gRPC call lands)`)}` : ""}`)
          .on_click((_e, cx) => { this.pickCandidate(i, cx); cx.notify(); })
          .when(Boolean(d.via), (el) => el.child(div().px(4).rounded(3).bg((d.via.kind === "rpc" ? t.ansi4 : t.ansi5) + "33").text_color(t.foreground).child(d.via.kind === "rpc" ? `gRPC ← ${/^pkg\/([^/]+)/.exec(d.path)?.[1] ?? L("別のサービス", "another service")}` : L("実装", "impl"))))
          .child(`${d.path.split("/").slice(-3).join("/")}:${d.line}`)))))
      .when(Boolean(this.codeNote), (el) => el.child(div().px(12).py(6).flex_none().text_size(12).text_color(t.blocked).child(this.codeNote)))
      .child(div().id("code-area").flex_1().min_h(0).relative().on_size_change((size) => { col.codeH = unzoom(size.height); })
        .when(Boolean(c), (el) => el
          .child(div().id("code-x").absolute().inset_0().overflow_x_scrollbar().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
            // Where the press lands across the lines (the list reports only which line).
            .child(div().id("code-content").w_full().min_w(c.width).h_full().on_mouse_down("left", (e) => { this.pressX = unzoom(e.local_position?.x) ?? null; })
              .on_mouse_up("left", (_e, cx) => { if (this.sel?.active) { this.endSel(); cx.notify(); } })
              // A file of up to PLAIN_MAX lines is drawn whole, so a drag over its text selects it;
              // a longer one is drawn as a list of what is on screen, where text can't be selected.
              .when(c.rows.length <= PLAIN_MAX, (el) => el.child(v_flex().id(lines).size_full().overflow_y_scroll().track_scroll(this.codePlain)
                .children(c.rows.map((row, i) => this.codeRow(row, i, t).id(`cr-${c.path}-${i}`)
                  .on_mouse_down("left", (e, cx) => { this.useCol(k); this.startSel("code", i, unzoom(e.local_position?.x) ?? 0); cx.notify(); })
                  .on_mouse_move((e, cx) => { const p = localOf(e); if (p && this.moveSel(i, p.x)) cx.notify(); })
                  .on_click((_e, cx) => { if (this.selDone) { this.selDone = false; return; } this.pressCode(i); this.ensureBlame(cx); cx.notify(); })))))
              // The list draws its rows later, on its own: they are drawn for this column then too.
              .when(c.rows.length > PLAIN_MAX, (el) => el.child(v_virtual_list(lines, c.rows.length, ROW_H, (i) => `${c.path}-${i}`,
                (range) => this.inCol(col, () => c.rows.slice(range.start, range.end).map((row, j) => this.codeRow(row, range.start + j, t))) ?? [])
                .on_item_click((key, cx) => { this.pressCode(Number(key.slice(key.lastIndexOf("-") + 1))); this.ensureBlame(cx); cx.notify(); })
                .track_scroll(this.codeScroll).size_full()))))
          .child(Scrollbar.vertical(lines).viewport_from_layout().absolute().inset_0()))
        .when(!c && !this.codeBusy && !this.codeNote, (el) => el.child(div().absolute().top(10).left(14).text_size(12).text_color(t.dim).child(L("左のファイル一覧から、開くファイルを選んでください。", "Pick a file to open in the list on the left.")))));
  }

  // One line of the code view: its number and its colored text, with the part selected. The current
  // line also says who last changed it, when and in which commit (as GitLens does).
  codeRow(row, i, t) {
    return h_flex().w_full().h(ROW_H).flex_none().gap(12).when(i === this.codeAt, (e) => e.bg(t.selected))
      .child(div().w(48).flex_none().text_right().text_color(i === this.codeAt ? t.foreground : t.dim).child(String(i + 1)))
      .child(h_flex().flex_1().min_w(0).whitespace_nowrap().overflow_hidden().when((this.code?.rows.length ?? 0) <= PLAIN_MAX, (e) => e.cursor_text())
        .children(this.codeLine(row.segs, t, this.selIn("code", i)))
        .when(i === this.codeAt, (e) => e.child(this.blameTag(t, (this.code?.rows.length ?? 0) > PLAIN_MAX))));
  }

  // The current line's last change, from `git blame` at the pull request's head commit. Looked up
  // once per line, when a line becomes the current one.
  blameKey() {
    return this.picked && this.code ? `${this.picked.sha}|${this.code.path}|${this.codeAt + 1}` : null;
  }

  ensureBlame(cx) {
    const key = this.blameKey(), pr = this.picked, path = this.code?.path, line = this.codeAt + 1;
    if (!key || this.blames.has(key)) return;
    this.blames.set(key, { pending: true });
    cx.spawn(async (cx) => {
      try { this.blames.set(key, (await blameLine(pr, path, line)) ?? { none: true }); }
      catch (e) { this.blames.set(key, { error: String(e?.message ?? e) }); }
      cx.notify();
    });
  }

  // In a long file the lines are a virtual list's rows, which can't have handlers of their own
  // (registering one there throws, and the whole list goes blank): the tag is plain text there.
  blameTag(t, inList = false) {
    const b = this.blames.get(this.blameKey());
    if (!b || b.pending) return div();
    const base = div().id("blame").flex_none().pl(32).text_size(11).text_color(t.dim);
    if (b.error) return base.child(b.error);
    if (b.none) return base.child(L("この行の履歴はありません", "No history for this line"));
    // A commit of this pull request is said so: it is the change under review.
    const ours = (this.detail?.commits ?? []).some((c) => b.sha.startsWith(c.oid));
    const url = `https://github.com/${this.picked.repo}/commit/${b.sha}`;
    const label = `${b.author}, ${ago(b.at)} • ${ours ? L("この PR ・ ", "this PR · ") : ""}${b.summary}`;
    if (inList) return base.child(`${b.sha.slice(0, 7)} ${label}`);
    return base.cursor_pointer().hover((s) => s.text_color(t.muted)).tooltip(`${b.sha.slice(0, 7)} ${b.summary}\n${b.author} · ${new Date(b.at).toLocaleString(L("ja-JP", "en-US"))}\n${L("クリックで GitHub のコミットを開く", "Click to open the commit on GitHub")}`)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(url); })
      .child(label);
  }

  // Brings line `i` of the code view into view, however it is drawn now; "center" puts it in the
  // middle of the view (a definition jumped to), "top" at the top.
  // The whole-file view can only be asked to show a line with the least scrolling, so the middle is
  // reached in two steps: first the line half a view above it is shown, then, a frame later, the one
  // half a view below. From either direction that leaves line `i` in the middle.
  scrollCode(i, strategy, cx) {
    const total = this.code?.rows.length ?? 0;
    if (total > PLAIN_MAX) { this.codeScroll.scroll_to_item(i, strategy); return; }
    const half = Math.max(0, Math.floor((this.codeH ?? 0) / ROW_H / 2) - 1);
    if (strategy !== "center" || !half || !cx) { this.codePlain.scroll_to_item(i); return; }
    const col = this.cols[this.colAt], path = col.code.path, plain = col.codePlain;
    plain.scroll_to_item(Math.max(0, i - half));
    cx.timer.after(50, (cx) => {
      if (col.code?.path !== path) return;
      plain.scroll_to_item(Math.min(total - 1, i + half));
      cx.notify();
    });
  }

  draftsOf() { return this.drafts[this.picked?.url] ?? []; }
  // GitHub's Viewed mark on a file of the pull request shown.
  isViewed(file) { return this.viewedOn?.url === this.picked?.url && Boolean(this.viewedOn?.viewed.has(file.path)); }

  // The file the diff shows.
  current() {
    return this.files.find((f) => f.path === this.file) ?? this.files[0] ?? null;
  }

  selectFile(path) {
    this.file = path;
    this.diffAt = null;
    this.compose = null;
    this.rebuild();
    this.scrollDiff(0);
  }

  // The file `by` places after (or before) the shown one, in the order the list has them.
  stepFile(by) {
    const order = this.files;
    const to = order[order.findIndex((f) => f.path === this.current()?.path) + by];
    if (to) this.selectFile(to.path);
  }

  // Colors a file's lines once (kept on the rows). Each side carries its own open comment or string:
  // removed lines read on the old side, added lines on the new one, unchanged lines on both.
  colorFile(file) {
    if (!file || file.colored) return;
    file.colored = true;
    const lang = languageOf(file.path);
    let oldState = null, newState = null;
    for (const row of file.rows) {
      if (row.kind === "@") { oldState = newState = null; continue; }
      if (!["+", "-", " "].includes(row.kind)) continue;
      if (!lang) { row.segs = [{ text: row.text, kind: null }]; continue; }
      const from = row.kind === "-" ? oldState : newState;
      const { segs, state } = highlightLine(row.text, lang, from);
      row.segs = segs;
      if (row.kind !== "+") oldState = state;
      if (row.kind !== "-") newState = state;
    }
  }

  // A line's colored pieces, drawn in a row. Three things can lie over the colors: the part selected
  // (`sel`, characters `[from, to)`), every whole use of the marked name (as an editor marks the
  // occurrences of a selection), and what the search bar finds (any case).
  codeLine(segs, t, sel = null) {
    const color = { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 };
    const query = this.findQuery();
    if (!sel && !this.mark && !query) return segs.map((sg) => div().flex_none().when(Boolean(sg.kind), (e) => e.text_color(color[sg.kind])).child(sg.text));
    // Spans over the line, in characters (code points).
    const text = segs.map((sg) => sg.text).join("");
    const cp = (u16) => [...text.slice(0, u16)].length;
    const marks = [], finds = [];
    if (this.mark) for (const m of text.matchAll(this.markRe())) marks.push([cp(m.index), cp(m.index + m[0].length)]);
    if (query) {
      const low = text.toLowerCase();
      for (let k = low.indexOf(query); k >= 0; k = low.indexOf(query, k + query.length)) finds.push([cp(k), cp(k + query.length)]);
    }
    const within = (spans, a, b) => spans.some(([x, y]) => a >= x && b <= y);
    // The line is cut wherever a color or one of the three starts or ends; each piece knows which lie over it.
    const cuts = new Set([0]);
    let end = 0;
    for (const sg of segs) cuts.add(end += [...sg.text].length);
    for (const [x, y] of [...marks, ...finds, ...(sel ? [[Math.max(0, sel[0]), Math.min(end, sel[1])]] : [])]) { cuts.add(x); cuts.add(y); }
    const at = [...cuts].filter((x) => x >= 0 && x <= end).sort((a, b) => a - b);
    const chars = [...text];
    const kindAt = [];
    let k = 0;
    for (const sg of segs) for (const _ of sg.text) kindAt[k++] = sg.kind;
    const out = [];
    for (let j = 0; j + 1 < at.length; j++) {
      const a = at[j], b = at[j + 1];
      if (b <= a) continue;
      const picked = Boolean(sel) && a >= sel[0] && b <= sel[1], found = within(finds, a, b), marked = within(marks, a, b), kind = kindAt[a];
      out.push(div().flex_none().when(Boolean(kind), (e) => e.text_color(color[kind]))
        .when(picked, (e) => e.bg(t.selection))
        .when(!picked && found, (e) => e.bg(t.ansi3 + "59").rounded(2))
        .when(!picked && !found && marked, (e) => e.bg(t.accent + "4d").rounded(2))
        .child(chars.slice(a, b).join("")));
    }
    return out;
  }

  markRe() {
    return new RegExp(`(?<![A-Za-z0-9_$])${this.mark.replace(/\$/g, "\\$")}(?![A-Za-z0-9_$])`, "g");
  }

  // The rows of the shown file that use the marked name, in order.
  markRows() {
    if (!this.mark) return [];
    const re = this.markRe();
    const uses = (r) => Boolean(r?.text) && r.text.search(re) >= 0;
    return this.rows.map((r, i) => ((r.kind === "pair" ? uses(r.left) || uses(r.right) : ["+", "-", " "].includes(r.kind) && uses(r)) ? i : -1)).filter((i) => i >= 0);
  }

  // To the next (`by` 1) or previous (-1) row that uses the marked name.
  stepMark(by) {
    const rows = this.markRows();
    if (!rows.length) return;
    const now = rows.indexOf(this.markAt);
    const to = rows[(now < 0 ? (by > 0 ? 0 : rows.length - 1) : (now + by + rows.length) % rows.length)];
    this.markAt = to;
    this.scrollDiff(to);
  }

  // A file whose changes are all on one side -- only added lines, or only removed ones (a new or a
  // deleted file among them): there is nothing to set beside them.
  oneSided(file) {
    return Boolean(file) && (file.add === 0 || file.del === 0);
  }

  setSplit(on) {
    this.split = on;
    save("split", on);
    this.rebuild();
  }

  // Marks a file read, or unmarks it. Marking the shown file moves on to the next unread one.
  // Marks a file Viewed on GitHub, or takes the mark off; marking the shown file goes on to the next
  // one not viewed. The mark shows at once and is taken back if GitHub refuses it.
  toggleViewed(file, cx) {
    const v = this.viewedOn;
    if (!v || v.url !== this.picked?.url) { notify({ title: L("Viewed の印を付けられません", "Can't mark Viewed"), body: L("GitHub から印を読めていません。PR を開き直してください。", "The marks were not read from GitHub. Open the pull request again."), level: "warning" }); return; }
    const marking = !v.viewed.has(file.path);
    if (marking) v.viewed.add(file.path); else v.viewed.delete(file.path);
    cx?.spawn(async (cx) => {
      try { await setViewed(v.id, file.path, marking); }
      catch (e) {
        if (marking) v.viewed.delete(file.path); else v.viewed.add(file.path);
        notify({ title: L("Viewed の印を GitHub に送れませんでした", "Could not send the Viewed mark to GitHub"), body: String(e?.message ?? e).slice(0, 200), level: "warning" });
        cx.notify();
      }
    });
    if (marking && file.path === this.current()?.path) {
      const at = this.files.findIndex((f) => f.path === file.path);
      const next = [...this.files.slice(at + 1), ...this.files.slice(0, at)].find((f) => !this.isViewed(f));
      if (next) { this.selectFile(next.path); return; }
    }
    this.rebuild();
  }

  // The rows the diff pane draws: the shown file's lines -- one column, or before and after side by
  // side -- with the comments on a line (GitHub's and your unsent ones) right under it.
  rebuild() {
    const rows = [], sizes = [];
    const push = (row, size = ROW_H) => { rows.push(row); sizes.push(size); };
    const file = this.current();
    this.file = file?.path ?? null;
    this.colorFile(file);
    const threads = (this.detail?.threads ?? []).filter((c) => !c.outdated && c.line != null && c.path === file?.path);
    const drafts = this.draftsOf();
    // The comment box is as wide as the diff pane lets it be (not as wide as the longest code line).
    const boxW = this.commentWidth();
    const comment = (row, body) => { const lines = formatComment(body, boxW - 20 - (row.draft?.reply ? 24 : 0)); push({ ...row, lines }, 34 + lines.length * COMMENT_LINE); };
    const commentsOn = (row) => {
      if (row?.line == null) return;
      // GitHub's comments on this line, thread by thread, each thread followed by your unsent replies to it.
      const here = threads.filter((c) => c.line === row.line && c.side === row.side);
      const roots = [...new Set(here.map((c) => c.reply ?? c.id))];
      for (const root of roots) {
        const list = here.filter((c) => (c.reply ?? c.id) === root);
        // A resolved thread is one folded row, unless opened or answered in a draft.
        if (list[0].resolved) {
          const open = this.openResolved.has(root) || drafts.some((d) => d.reply === root);
          push({ kind: "resolved", root, list, open }, ROW_H + 8);
          if (!open) continue;
        }
        for (const c of list) comment({ kind: "thread", comment: c, root }, c.body);
        drafts.forEach((d, index) => { if (d.reply === root) comment({ kind: "draft", draft: d, index }, d.body); });
      }
      drafts.forEach((d, index) => { if (!d.reply && d.path === row.path && d.line === row.line && d.side === row.side) comment({ kind: "draft", draft: d, index }, d.body); });
    };
    let widest = 0;
    // A file changed on one side only (lines only added, or only removed) shows in one column whatever the setting.
    const split = this.split && !this.oneSided(file);
    if (file && !split) {
      for (const row of file.rows) { push(row); commentsOn(row); widest = Math.max(widest, row.text.length); }
    } else if (file) {
      // Each half wraps to its share of the pane: line number, mark and gaps take 64px of it, and a
      // little is kept spare, since the widths here are estimates of the font's.
      const halfText = Math.max(80, Math.floor(((this.paneW ?? 800) - 1) / 2) - HALF_X0 - 24);
      // A wrapped line keeps its colors: each piece takes the slice of the line's pieces it covers.
      const pieces = (row) => {
        if (!row) return [[]];
        let at = 0;
        return wrapCode(row.text, halfText).map((p) => { const n = [...p].length, segs = sliceSegs(row.segs ?? [{ text: row.text, kind: null }], at, at + n); at += n; return segs; });
      };
      const pushPair = (left, right) => {
        const l = pieces(left), r = pieces(right);
        const lines = Math.min(40, Math.max(l.length, r.length));
        push({ kind: "pair", left, right, l, r, lines }, lines * ROW_H);
      };
      // Removed lines pair with the added lines that follow them; an unchanged line stands on both sides.
      let gone = [], come = [];
      const flush = () => {
        for (let k = 0; k < Math.max(gone.length, come.length); k++) {
          const left = gone[k] ?? null, right = come[k] ?? null;
          pushPair(left, right);
          commentsOn(left);
          commentsOn(right);
          widest = Math.max(widest, left?.text.length ?? 0, right?.text.length ?? 0);
        }
        gone = []; come = [];
      };
      for (const row of file.rows) {
        if (row.kind === "-") gone.push(row);
        else if (row.kind === "+") come.push(row);
        else {
          flush();
          if (row.kind === " ") { pushPair(row, row); commentsOn(row); widest = Math.max(widest, row.text.length); }
          else push(row);
        }
      }
      flush();
    }
    this.rows = rows;
    this.sizes = sizes;
    // Side by side, the two halves share the pane (a long line is cut at its half's edge);
    // in one column the pane scrolls sideways to the longest line.
    this.width = split ? 300 : Math.max(300, (widest + 1) * HIT_W + ONE_X0 + 16);
  }

  commentWidth() {
    return Math.max(260, Math.min(900, (this.paneW ?? 800) - 58 - 24));
  }

  // A draft still has its place: the line it is on is in the diff, or (a reply) the comment it answers is still there.
  anchored(d) {
    if (d.reply) return (this.detail?.threads ?? []).some((c) => (c.reply ?? c.id) === d.reply && !c.outdated);
    const has = (line) => this.files.some((f) => f.path === d.path && f.rows.some((r) => r.line === line && r.side === d.side));
    return has(d.line) && (d.startLine == null || has(d.startLine));
  }

  // The + of a line: a comment on that line, or -- with Shift, while a new comment is open on the same
  // side of the file -- the comment widened to run from where it started to this line.
  plusPressed(row) {
    const c = this.compose;
    if (this.pressShift && c && c.index == null && !c.reply && c.path === row.path && c.side === row.side && c.line !== row.line) {
      const anchor = c.anchor ?? c.line;
      if (this.hunkOf(row) !== this.hunkOf({ line: anchor, side: c.side })) { this.composeNote = L("複数行のコメントは、同じ差分のまとまり（@@ で区切られた範囲）の中でしか付けられません。", "A comment on several lines must stay within one hunk (the range an @@ line starts)."); return; }
      this.compose = { ...c, anchor, startLine: Math.min(anchor, row.line), line: Math.max(anchor, row.line) };
      this.composeNote = null;
      return;
    }
    this.startDraft(row);
  }

  // Brings a row of the diff into view, however the diff is drawn now.
  scrollDiff(i) {
    if (this.rows.length <= PLAIN_MAX) this.plainScroll.scroll_to_item(i);
    else this.diffScroll.scroll_to_item(i, i === 0 ? "top" : "center");
  }

  // The line of a row a + belongs to: the row itself, or one side of a side-by-side row.
  sideOf(i, side) {
    const r = this.rows[i];
    if (!r) return null;
    if (r.kind === "pair") return side === "l" ? r.left : r.right;
    return ["+", "-", " "].includes(r.kind) ? r : null;
  }

  // A drag from a + ended on another line: a comment on every line from where it started to there.
  endDrag() {
    const d = this.drag;
    this.drag = null;
    if (!d || d.to === d.from) return false;
    const a = this.sideOf(d.from, d.side), b = this.sideOf(d.to, d.side);
    if (a?.line == null) return false;
    this.startDraft(a);
    if (b?.line != null && b.side === a.side && b.line !== a.line) {
      if (this.hunkOf(b) !== this.hunkOf(a)) this.composeNote = L("複数行のコメントは、同じ差分のまとまり（@@ で区切られた範囲）の中でしか付けられません。", "A comment on several lines must stay within one hunk (the range an @@ line starts).");
      else this.compose = { ...this.compose, anchor: a.line, startLine: Math.min(a.line, b.line), line: Math.max(a.line, b.line) };
    }
    return true;
  }

  // Which hunk of the shown file a line is in (GitHub takes a multi-line comment within one hunk only).
  hunkOf({ line, side }) {
    let hunk = -1;
    for (const r of this.current()?.rows ?? []) {
      if (r.kind === "@") hunk++;
      else if (r.line === line && r.side === side) return hunk;
    }
    return null;
  }

  // Whether a line of the diff is inside the range of the comment being written.
  // ---- searching the file shown --------------------------------------------
  // Cmd+F (or Ctrl+F) opens a bar over the code or the diff. What is typed is looked for in the file shown, in
  // any case; every match is marked, the first one from the current line on is brought into view,
  // and Enter / Shift+Enter go to the next / previous line with one. Escape closes the bar.

  // What the bar looks for (lower case), or "" when it is closed or empty.
  findQuery() {
    return this.findOpen ? (this.findInput?.value() ?? "").toLowerCase() : "";
  }

  // The text of each row of what is shown: the code's lines, or the diff's (both halves of a side-by-side row).
  findLines() {
    if (this.view === "code") return (this.code?.rows ?? []).map((r) => r.text);
    return this.rows.map((r) => (r.kind === "pair" ? `${r.left?.text ?? ""}\n${r.right?.text ?? ""}` : ["+", "-", " "].includes(r.kind) ? r.text : ""));
  }

  openFind() {
    this.findOpen = true;
    this.findInput.focus();
    const value = this.findInput.value();
    if (value) this.findInput.set_selected_range({ start: 0, end: value.length });
  }

  closeFind() {
    this.findOpen = false;
    this.findHits = [];
    this.findAt = -1;
    this.selFocus.focus();
  }

  // Looks again (the text changed, or the file or view did); goes to the first match from the current line on.
  runFind(cx) {
    const q = this.findQuery();
    this.findKey = this.selKey();
    this.findHits = [];
    this.findAt = -1;
    if (!q) return;
    this.findLines().forEach((text, i) => { if (text.toLowerCase().includes(q)) this.findHits.push(i); });
    if (!this.findHits.length) return;
    const here = this.view === "code" ? this.codeAt : this.diffHere();
    const from = this.findHits.findIndex((i) => i >= here);
    this.goFind(from >= 0 ? from : 0, cx);
  }

  stepFind(by, cx) {
    if (this.findKey !== this.selKey()) { this.runFind(cx); return; }
    const n = this.findHits.length;
    if (!n) return;
    this.goFind(((this.findAt < 0 ? (by > 0 ? -1 : 0) : this.findAt) + by + n) % n, cx);
  }

  goFind(k, cx) {
    this.findAt = k;
    const row = this.findHits[k];
    if (this.view === "code") { this.codeAt = row; this.scrollCode(row, "center", cx); this.ensureBlame(cx); }
    else { this.diffAt = row; this.scrollDiff(row); }
  }

  // In the code view `col` is the column the bar is over: its buttons and Esc act on that column
  // (a press on them doesn't make the column the one in use).
  findBar(t, col = null) {
    const inCol = (fn) => (col ? this.inCol(col, fn) : fn());
    const stale = this.findKey !== this.selKey();
    const n = this.findHits.length, q = this.findQuery();
    const count = !q ? "" : stale ? L("Enter で検索", "Enter to search") : n ? L(`${this.findAt + 1} / ${n} 行`, `${this.findAt + 1} of ${n} lines`) : L("見つかりません", "No results");
    const button = (id, icon, tip, onClick) => div().id(id).w(22).h(22).flex_none().flex().items_center().justify_center().rounded(R.sm).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { inCol(() => onClick(cx)); cx.notify(); }).child(ico(icon, 12, t.muted));
    return h_flex().id("find-bar").h(34).flex_none().px(8).gap(6).items_center().border_b(1).border_color(t.border).bg(t.chrome).text_size(12)
      .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); inCol(() => this.closeFind()); cx.notify(); } })
      .child(h_flex().id("find-box").w(320).h(26).px(8).flex_none().items_center().rounded(R.sm).border(1).border_color(t.input).bg(t.background)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(this.findInput).flex_1().h_full().text_size(12).text_color(t.foreground)))
      .child(div().flex_none().min_w(80).text_color(q && !n && !stale ? t.blocked : t.muted).child(count))
      .child(button("find-prev", "chevron-up", L("前の一致（Shift+Enter）", "Previous match (Shift+Enter)"), (cx) => this.stepFind(-1, cx)))
      .child(button("find-next", "chevron-down", L("次の一致（Enter）", "Next match (Enter)"), (cx) => this.stepFind(1, cx)))
      .child(div().flex_1())
      .child(button("find-close", "x", L("閉じる（Esc）", "Close (Esc)"), () => this.closeFind()));
  }

  // ---- selecting text ------------------------------------------------------
  // A drag over the text of the lines (not from a +) selects text on one side: the code, the one
  // column of the diff, or one half of the side-by-side diff. A press without a drag is still a click
  // (it marks the name under it). Cmd+C, or the bar's copy button, copies what is selected.

  // What the selection belongs to: the view, its file and how the diff is laid out. A selection
  // made in another of these is not shown or copied.
  selKey() {
    if (this.view === "code") return `code|${this.code?.path ?? ""}`;
    const f = this.current();
    return `diff|${f?.path ?? ""}|${Boolean(f && this.split && !this.oneSided(f))}`;
  }

  // The text of row `i` on a side ("code", "one", "l" or "r"), or null when that row has no line there.
  selLineText(side, i) {
    if (side === "code") return this.code?.rows[i]?.text ?? null;
    const row = this.rows[i];
    if (!row) return null;
    if (side === "one") return ["+", "-", " "].includes(row.kind) ? row.text : null;
    if (row.kind !== "pair") return null;
    return (side === "l" ? row.left : row.right)?.text ?? null;
  }

  // Where a pointer at `x` across row `i` (and `y` down it, for a wrapped half) falls between the
  // characters of that side's line: a character index from 0.
  selColAt(side, i, x, y) {
    const colIn = (text, px) => {
      const chars = [...text];
      let at = 0, used = 0;
      while (at < chars.length) {
        const w = chars[at].charCodeAt(0) < 0x2e80 ? HIT_W : HIT_WIDE;
        if (used + w / 2 > px) break;
        used += w; at++;
      }
      return at;
    };
    if (side === "code") return colIn(this.selLineText(side, i) ?? "", x - CODE_X0);
    if (side === "one") return colIn(this.selLineText(side, i) ?? "", x - ONE_X0);
    const row = this.rows[i];
    const pieces = (side === "l" ? row?.l : row?.r) ?? [];
    const k = Math.max(0, Math.min(pieces.length - 1, Math.floor((y ?? 0) / ROW_H)));
    let before = 0;
    for (let j = 0; j < k; j++) before += pieces[j].reduce((n, sg) => n + [...sg.text].length, 0);
    const text = (pieces[k] ?? []).map((sg) => sg.text).join("");
    return before + colIn(text, x - HALF_X0);
  }

  // The selection's ends in reading order, or null when there is none to show here.
  selRange() {
    const s = this.sel;
    if (!s || s.key !== this.selKey()) return null;
    const [a, b] = s.a.row < s.b.row || (s.a.row === s.b.row && s.a.col <= s.b.col) ? [s.a, s.b] : [s.b, s.a];
    return a.row === b.row && a.col === b.col ? null : { side: s.side, a, b };
  }

  // The part of row `i`'s line on `side` that is selected, as characters `[from, to)` of the piece
  // starting at character `start` and `len` long; null when none of it is.
  selIn(side, i, start = 0, len = Infinity) {
    const r = this.selRange();
    if (!r || r.side !== side || i < r.a.row || i > r.b.row || this.selLineText(side, i) == null) return null;
    const from = Math.max(start, i === r.a.row ? r.a.col : 0), to = Math.min(start + len, i === r.b.row ? r.b.col : Infinity);
    return to > from ? [from - start, to - start] : null;
  }

  // The selected text, its lines joined by newlines (rows without a line on that side are left out).
  selText() {
    const r = this.selRange();
    if (!r) return "";
    const lines = [];
    for (let i = r.a.row; i <= r.b.row; i++) {
      const text = this.selLineText(r.side, i);
      if (text == null) continue;
      const chars = [...text];
      lines.push(chars.slice(i === r.a.row ? r.a.col : 0, i === r.b.row ? r.b.col : chars.length).join(""));
    }
    return lines.join("\n");
  }

  copySel(cx) {
    const text = this.selText();
    if (!text) { notify({ title: L("コピーする文字が選ばれていません", "Nothing selected to copy"), body: L("差分かコードの文字をドラッグして選んでください。", "Drag over text in the diff or the code to select it."), level: "info" }); return; }
    cx.write_to_clipboard(text);
    notify({ title: L("コピーしました", "Copied"), body: L(`${text.split("\n").length} 行・${[...text].length} 文字`, `${text.split("\n").length} lines · ${[...text].length} characters`), level: "info", timeout: 2000 });
  }

  // A press on the text of row `i` starts a selection there; `side` is where it was pressed.
  startSel(side, i, x, y) {
    if (this.selLineText(side, i) == null) { this.sel = null; return; }
    const at = { row: i, col: this.selColAt(side, i, x, y) };
    this.sel = { key: this.selKey(), side, a: at, b: { ...at }, active: true };
    this.selFocus.focus();
  }

  // The pointer over row `i` while the button is held moves the selection's end there. True when it moved.
  moveSel(i, x, y) {
    const s = this.sel;
    if (!s?.active || this.selLineText(s.side, i) == null) return false;
    const col = this.selColAt(s.side, i, x, y);
    if (s.b.row === i && s.b.col === col) return false;
    s.b = { row: i, col };
    return true;
  }

  // Letting go: a press that selected nothing is a click, and the selection is dropped.
  endSel() {
    const s = this.sel;
    if (!s?.active) return;
    s.active = false;
    if (this.selRange()) this.selDone = true;
    else this.sel = null;
  }

  inRange(r) {
    if (!r || r.line == null) return false;
    const d = this.drag;
    if (d && d.to !== d.from) {
      const a = this.sideOf(d.from, d.side), b = this.sideOf(d.to, d.side);
      if (a && b && a.side === b.side) return r.path === a.path && r.side === a.side && r.line >= Math.min(a.line, b.line) && r.line <= Math.max(a.line, b.line);
    }
    const c = this.compose;
    return Boolean(c && c.startLine != null && r.path === c.path && r.side === c.side && r.line >= c.startLine && r.line <= c.line);
  }

  startDraft(row, index = null) {
    const d = index == null ? null : this.draftsOf()[index];
    this.composeNote = null;
    this.compose = { path: row.path, line: row.line, side: row.side, index, reply: d?.reply ?? null, to: d?.to ?? null, startLine: d?.startLine ?? null };
    this.editor.set_value(d?.body ?? "");
    this.editor.focus();
  }

  // Answers a comment GitHub already has: the reply joins the thread that comment is in.
  startReply(row) {
    const c = row.comment;
    this.compose = { path: c.path, line: c.line, side: c.side, index: null, reply: row.root, to: c.user };
    this.editor.set_value("");
    this.editor.focus();
  }

  saveDraft(cx) {
    const body = this.editor.value().trim();
    if (!this.compose || !body) return;
    const list = (this.drafts[this.picked.url] ??= []);
    const { path, line, side, index, reply, to, startLine } = this.compose;
    const range = startLine != null && startLine < line ? { startLine } : {};
    if (index == null) list.push({ path, line, side, body, ...range, ...(reply ? { reply, to } : {}) }); else list[index] = { ...list[index], body };
    save("drafts", this.drafts);
    this.compose = null;
    this.rebuild();
    cx.notify();
  }

  dropDraft(index) {
    const list = this.draftsOf();
    list.splice(index, 1);
    if (!list.length) delete this.drafts[this.picked.url];
    save("drafts", this.drafts);
    this.compose = null;
    this.rebuild();
  }

  // Sends everything written on this pull request as one review. The first press arms it;
  // the second one sends: what goes out reaches other people and cannot be taken back.
  send(event, cx) {
    if (this.sending) return;
    if (this.confirm !== event) { this.confirm = event; cx.notify(); return; }
    const pr = this.picked;
    const drafts = this.draftsOf();
    const lost = drafts.filter((d) => !this.anchored(d));
    const body = [this.reviewBody.value().trim(), ...(lost.length ? [L("行に貼り直せなかったコメント:", "Comments that no longer fit a line:"), ...lost.map((d) => `- \`${d.path}:${d.line}\`${d.reply ? L(`（${d.to ?? ""} への返信）`, ` (reply to ${d.to ?? ""})`) : ""} ${d.body}`)] : [])].filter(Boolean).join("\n\n");
    const comments = drafts.filter((d) => !d.reply && this.anchored(d)).map(({ path, line, side, body, startLine }) => ({ path, line, side, body, ...(startLine != null ? { start_line: startLine, start_side: side } : {}) }));
    const replies = drafts.filter((d) => d.reply && this.anchored(d)).map((d) => ({ to: d.reply, body: d.body }));
    if (event === "COMMENT" && !body && !comments.length && !replies.length) { this.sendError = L("送る内容がありません。本文か行コメントを書いてください。", "Nothing to send: write a summary or a line comment."); this.confirm = null; cx.notify(); return; }
    this.sending = true;
    this.sendError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await submitReview(pr, { event, body, comments, replies });
        delete this.drafts[pr.url];
        save("drafts", this.drafts);
        this.reviewBody.set_value("");
        this.side = null;
        notify({ title: event === "APPROVE" ? L("Approve しました", "Approved") : L("レビューを送信しました", "Review submitted"), body: L(`${pr.repoName} #${pr.number}（行コメント ${comments.length} 件・返信 ${replies.length} 件）`, `${pr.repoName} #${pr.number} (${comments.length} line comments, ${replies.length} replies)`), level: "info" });
        this.rebuild();
        this.readLists(cx);
      } catch (e) {
        // A write that errors may still have arrived: GitHub is the place to look before retrying.
        this.sendError = `${String(e?.message ?? e)}${L("（届いたかどうかは GitHub で確かめてから、送り直してください）", " (check on GitHub whether it arrived before sending again)")}`;
      }
      this.sending = false;
      this.confirm = null;
      cx.notify();
    });
  }

  // A Claude Code session about this pull request, in a tab shown on the right.
  // The tab of this pull request's Claude Code session, while it runs (closing the pane leaves it running).
  chatTab(pr = this.picked) {
    if (!pr) return null;
    const names = [`${pr.repoName}#${pr.number}${CHAT_SUFFIX}`, `${pr.repoName}#${pr.number}${OLD_CHAT_SUFFIX}`];
    return spaces().flatMap((sp) => sp.tabs).find((x) => names.includes(x.name)) ?? null;
  }

  // The questions "Ask Claude" offers: yours from config.json, else the screen's two.
  prompts() { return this.config?.prompts ?? defaultPrompts(); }

  // "Ask Claude" shows the questions. With a session already running for this pull request, its
  // pane opens again on it at the same time (closing the pane leaves the session running).
  pressAsk() {
    this.askOpen = !this.askOpen;
    const tab = this.chatTab();
    if (!tab || !this.askOpen) return;
    run("layout.show", { id: "review-chat" });
    run("tab.select", { id: tab.id });
  }

  ask(preset, cx) {
    const pr = this.picked;
    const name = `${pr.repoName}#${pr.number}${CHAT_SUFFIX}`;
    const tab = this.chatTab(pr);
    this.askOpen = false;
    run("layout.show", { id: "review-chat" });
    if (tab) {
      // The running session already knows the pull request: the question goes into it as the next
      // message. `hc send` waits while something you typed there is still unsent.
      run("tab.select", { id: tab.id });
      const terminal = panes().find((p) => p.tab === tab.id && p.terminal)?.terminal;
      if (!terminal) { notify({ title: L("質問を送れませんでした", "Could not send the question"), body: L(`${tab.name} のタブに端末が見つかりません。`, `The ${tab.name} tab has no terminal.`), level: "warning" }); return; }
      cx.spawn(async () => {
        const r = await hc(["send", terminal, preset.ask]);
        if (r.code !== 0) notify({ title: L("質問を送れませんでした", "Could not send the question"), body: (r.stderr.trim().split("\n")[0] || `exit ${r.code}`).slice(0, 200), level: "warning" });
      });
      return;
    }
    cx.spawn(async () => {
      const clone = `${home()}/ghq/github.com/${pr.repo}`;
      const folder = (await fs.exists(clone)) ? clone : home();
      const task = L(
        `${preset.ask}\n\nPR: ${pr.url}\n題: ${pr.title}\n\n読み取りだけで進めてください。ブランチの切り替え、ファイルの変更、GitHub への投稿（コメント・レビュー・マージ）はしないでください。まず gh pr view と gh pr diff で内容を確かめてください。`,
        `${preset.ask}\n\nPR: ${pr.url}\nTitle: ${pr.title}\n\nOnly read: don't switch branches, change files, or post to GitHub (comments, reviews, merges). Start with gh pr view and gh pr diff.`);
      run("tab.new", { name, folder, argv: ["claude"], task });
    });
    // Once the tab exists, the pane is shown again: nothing else may have closed it meanwhile.
    cx.timer.after(600, () => run("layout.show", { id: "review-chat" }));
  }

  // ---- drawing: the list ---------------------------------------------------

  // An input with its hint drawn behind it while it is empty (an input's own hint can't change
  // language once made).
  inputBox(id, state, hint, t) {
    return div().id(id).relative().flex_1().min_w(0).h(26).px(8).flex().items_center().rounded(8).border(1).border_color(t.input).bg(t.background)
      .on_mouse_down("left", stop)
      .when(!state.value(), (el) => el.child(div().absolute().left(9).top(5).text_size(12).text_color(t.dim).whitespace_nowrap().child(hint)))
      .child(Input.new(state).flex_1().h_full().text_size(12).text_color(t.foreground));
  }

  list(t) {
    const prs = this.shown();
    const groups = this.groups();
    const source = this.lists[this.tab] ?? [];
    const bots = source.filter((pr) => pr.bot).length;
    const pill = (id, label, on, onClick, tip) => div().id(id).h(24).px(8).flex_none().flex().items_center().rounded(8).text_size(12)
      .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
      .when(Boolean(tip), (el) => el.tooltip(tip)).on_click(onClick).child(label);
    const total = this.totals[this.tab] ?? source.length;
    const row = ({ pr, depth }) => {
      const [group, reason] = this.triage(pr);
      const g = GROUPS[GROUP_AT[group]];
      const on = this.picked?.url === pr.url;
      const [mark, ciText, ciColor] = ciOf(pr);
      const base = this.parent.get(pr.url);
      const decision = decisionOf(pr);
      return h_flex().id(`pr-${pr.url}`).flex_none().pl(8 + depth * 16).pr(8).py(6).gap(6).items_start().rounded(8)
        .when(on, (el) => el.bg(t.selected)).cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip(`${g.label()}: ${reason}`)
        .on_click((_e, cx) => { this.pick(pr, cx); })
        .when(depth > 0, (el) => el.child(div().pt(2).flex_none().child(ico("corner-down-right", 12, t.dim))))
        .child(v_flex().flex_1().min_w(0).gap(4)
          .child(div().text_size(12).text_color(pr.draft || group === "watch" ? t.muted : t.foreground).child(pr.title))
          .child(h_flex().gap(8).items_center().text_size(11).text_color(t.dim)
            .child(div().flex_none().child(`${pr.repoName} #${pr.number}`))
            .child(div().min_w(0).truncate().child(pr.author))
            // Set in under its base, the base needs no saying; standing alone, it does.
            .when(Boolean(base) && depth === 0, (el) => el.child(div().flex_none().text_color(t.muted).child(`${L("ベース", "base")}: #${base?.number}`)))
            .when(pr.draft, (el) => el.child(div().flex_none().px(4).rounded(4).bg(t.raised).child("Draft")))
            .when((this.drafts[pr.url] ?? []).length > 0, (el) => el.child(ico("pencil", 12, t.accent)))
            .when(this.threads.has(pr.url), (el) => el.child(image("mods/pr-review/slack.svg").w(11).h(11).flex_none()))
            .child(div().flex_1())
            .when(Boolean(decision), (el) => el.child(div().flex_none().text_color(t[decision[1]]).child(decision[0])))
            .child(div().id(`ci-${pr.url}`).flex_none().tooltip(ciText).child(ico(mark, 12, t[ciColor])))
            .child(div().flex_none().child(ago(pr.updatedAt)))));
    };
    const tabs = this.tabs();
    return v_flex().w(this.widths.list).flex_none().h_full().min_h(0).bg(t.chrome)
      .child(h_flex().id("list-tabs").h(36).flex_none().px(8).gap(4).items_center().border_b(1).border_color(t.border).overflow_x_scrollbar()
        .children(tabs.map((x) => pill(`tab-${x.id}`, `${x.label()} ${(this.lists[x.id] ?? []).filter((pr) => this.showBots || !pr.bot).length}`, this.tab === x.id, (_e, cx) => { this.setTab(x.id); cx.notify(); }, x.query))))
      .child(h_flex().flex_none().px(8).py(6).gap(6).items_center().border_b(1).border_color(t.border)
        .child(this.inputBox("pr-search", this.search, L("絞り込み（review:approved なども）", "Filter (or review:approved …)"), t)
          .tooltip(L("題・番号・リポジトリ・作者で絞る。review:required / approved / changes、is:draft、ci:failing / passing、author:名前、repo:名前 も使えます", "Matches title, number, repository and author. Also: review:required / approved / changes, is:draft, ci:failing / passing, author:<login>, repo:<name>")))
        .child(pill("sort", SORTS.find((x) => x.id === this.sort).label(), false, (_e, cx) => { this.command("sort", cx); cx.notify(); }, L("グループの中の並べ方を切り替える（更新順 → 新しい順 → 古い順）", "Change the order within each group (Updated → Newest → Oldest)"))))
      .child(h_flex().flex_none().px(12).h(24).gap(8).items_center().text_size(11).text_color(t.dim)
        .child(div().child(total > source.length ? L(`${prs.length} 件（${total} 件中 ${source.length} 件まで取得）`, `${prs.length} (first ${source.length} of ${total})`) : L(`${prs.length} 件`, `${prs.length}`)))
        .child(div().flex_1())
        .when(bots > 0, (el) => el.child(div().id("bots").cursor_pointer().hover((s) => s.text_color(t.foreground)).tooltip(L("Renovate などの Bot が作った PR を表示する・隠す", "Show or hide pull requests opened by bots (Renovate and the like)"))
          .on_click((_e, cx) => { this.showBots = !this.showBots; save("bots", this.showBots); cx.notify(); })
          .child(this.showBots ? L(`Bot の ${bots} 件を隠す`, `Hide ${bots} by bots`) : L(`Bot の ${bots} 件も表示`, `Show ${bots} by bots`))))
        .child(div().id("lang").cursor_pointer().hover((s) => s.text_color(t.foreground))
          .tooltip(L("表示の言語を切り替える（日本語 → English → Mac に合わせる）", "Change the screen's language (日本語 → English → as the Mac)"))
          .on_click((_e, cx) => { this.setLanguage(({ ja: "en", en: "auto", auto: "ja" })[this.lang] ?? "auto", cx); cx.notify(); })
          .child(this.lang === "auto" ? L("言語: Mac", "Lang: Mac") : this.lang === "ja" ? "日本語" : "English"))
        .child(div().id("reload").cursor_pointer().hover((s) => s.text_color(t.foreground)).tooltip(L("GitHub から取り直す", "Load again from GitHub"))
          .on_click((_e, cx) => this.readLists(cx)).child(this.loading ? L("更新中…", "Loading…") : L("更新", "Reload"))))
      .when(Boolean(this.listError || this.configError), (el) => el.child(div().mx(8).mb(6).px(12).py(8).flex_none().rounded(8).bg(t.blocked + "1f").border(1).border_color(t.blocked + "66").text_size(12).text_color(t.foreground).child([this.listError, this.configError].filter(Boolean).join("\n"))))
      .child(v_flex().id("pr-list").flex_1().min_h(0).px(6).pb(6).gap(2).overflow_y_scrollbar()
        .children(groups.flatMap(({ g, rows }) => [
          h_flex().flex_none().px(6).pt(10).pb(4).gap(6).items_center().border_b(1).border_color(t.border).text_size(11)
            .child(div().font_bold().text_color(t.foreground).child(g.label()))
            .child(div().px(5).rounded(8).bg(t.raised).text_color(t.muted).child(String(rows.length)))
            .child(div().min_w(0).truncate().text_color(t.dim).child(g.hint())),
          ...rows.map(row),
        ]))
        .when(prs.length === 0 && !this.listError, (el) => el.child(div().px(8).py(12).text_size(12).text_color(t.dim)
          .child(this.loading ? L("GitHub から読み込み中…", "Loading from GitHub…") : L("この条件に合う PR はありません。", "No pull requests match.")))));
  }

  // ---- drawing: one pull request -------------------------------------------

  head(t) {
    const pr = this.picked;
    const drafts = this.draftsOf().length;
    const [mark, ciText, ciColor] = ciOf(pr);
    const decision = decisionOf(pr);
    // A status tag: a dot (or an icon) and its word, so the state never rests on color alone.
    const chip = (label, color, icon = null) => h_flex().flex_none().px(6).h(20).gap(6).items_center().rounded(R.sm).bg(color + "26").text_size(11).text_color(t.foreground)
      .child(icon ? ico(icon, 12, color) : div().size(8).flex_none().rounded(R.full).bg(color)).child(label);
    const button = (id, label, tip, on, onClick) => div().id(id).flex_none().px(8).h(24).flex().items_center().rounded(8).text_size(12)
      .bg(on ? t.selected : t.surface).text_color(on ? t.foreground : t.muted).border(1).border_color(t.border)
      .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(onClick).child(label);
    return v_flex().flex_none().px(16).py(8).gap(6).border_b(1).border_color(t.border)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(14).font_bold().text_color(t.foreground).child(pr.title))
        .when(this.threads.has(pr.url), (el) => el.child(button("b-slack", h_flex().gap(6).items_center().child(image("mods/pr-review/slack.svg").w(12).h(12).flex_none()).child("Slack"), `${L("Slack でこの PR のスレッドを開く", "Open this pull request's Slack thread")}\n${this.threads.get(pr.url)}`, false, () => exec("open", [this.threads.get(pr.url)]))))
        .child(button("b-code", this.view === "code" ? L("差分に戻る", "Back to diff") : L("コード", "Code"), this.view === "code" ? L("同じ場所の差分に戻る（Cmd+Shift+C）", "Back to the diff at the same place (Cmd+Shift+C)") : L("変更後のファイルを、いま見ている行で開く（Cmd+Shift+C。名前を選んで F12 で定義へ）", "Open the changed file at this line (Cmd+Shift+C; pick a name and press F12 for its definition)"), this.view === "code", (_e, cx) => { this.toggleCode(cx); cx.notify(); }))
        .child(button("b-info", L("情報", "Details"), L("本文・コミット・レビュー・チェックを見る", "Description, commits, reviews and checks"), this.side === "info", (_e, cx) => { this.side = this.side === "info" ? null : "info"; cx.notify(); }))
        .child(button("b-ask", L("Claude に聞く", "Ask Claude"), this.chatTab() ? L("この PR の Claude Code の会話を右に開き、続けて聞く", "Open this pull request's Claude Code session on the right and ask on") : L("この PR について Claude Code に聞く（右に開きます）", "Ask Claude Code about this pull request (opens on the right)"), this.askOpen, (_e, cx) => { this.pressAsk(); cx.notify(); }))
        .child(button("b-send", drafts ? `${L("レビューを送信", "Submit review")} ${drafts}` : L("レビューを送信", "Submit review"), L("行コメントと本文を 1 回のレビューとして送る・Approve する", "Send the line comments and a summary as one review, or approve"), this.side === "send", (_e, cx) => { this.side = this.side === "send" ? null : "send"; this.confirm = null; cx.notify(); }))
        .child(div().id("open-pr").flex_none().px(8).h(24).flex().items_center().rounded(8).bg(t.solid).text_color(t.solid_foreground).text_size(12).cursor_pointer()
          .hover((s) => s.opacity(0.85)).tooltip(pr.url).on_click(() => exec("open", [pr.url])).child(L("GitHub で開く", "Open on GitHub"))))
      .child(h_flex().gap(8).items_center().text_size(12).text_color(t.muted)
        .child(div().flex_none().child(`${pr.repo} #${pr.number}`))
        .child(div().flex_none().child(pr.author))
        .child(div().flex_none().text_color(t.dim).child(`${pr.head} → ${pr.base}`))
        .child(div().flex_none().text_color(t.ansi2).child(`+${pr.add}`))
        .child(div().flex_none().text_color(t.ansi1).child(`−${pr.del}`))
        .child(div().flex_none().child(L(`${pr.files} ファイル`, `${pr.files} files`)))
        .when(pr.draft, (el) => el.child(chip("Draft", t.dim)))
        .when(Boolean(decision), (el) => el.child(chip(decision[0], t[decision[1]])))
        .child(chip(ciText, t[ciColor], mark)))
      // The questions to start with, and a box to ask anything (Enter sends).
      .when(this.askOpen, (el) => el.child(h_flex().gap(6).items_center().pt(2).text_size(12)
        .children(this.prompts().map((p, i) => div().id(`ask-${i}`).flex_none().px(8).h(24).flex().items_center().rounded(8).bg(t.raised).text_color(t.foreground)
          .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(p.ask).on_click((_e, cx) => this.ask(p, cx)).child(p.label)))
        .child(this.inputBox("ask-box", this.askInput, L("Claude に聞く（Enter で送る）", "Ask Claude (Enter sends)"), t))));
  }

  // The files as a tree: folders in the order of their paths, a folder that holds only one folder
  // joined with it on one line (as editors do), its subfolders before its files. Generated files
  // come last, dimmed, by their whole path. A folder folds when its line is pressed.
  fileTree() {
    const root = { dirs: new Map(), files: [] };
    for (const f of this.files) {
      if (f.generated) continue;
      const parts = f.path.split("/");
      let at = root;
      for (const dir of parts.slice(0, -1)) { if (!at.dirs.has(dir)) at.dirs.set(dir, { dirs: new Map(), files: [] }); at = at.dirs.get(dir); }
      at.files.push(f);
    }
    const out = [];
    const walk = (node, path, depth) => {
      for (const [name, sub] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
        let label = name, full = path ? `${path}/${name}` : name, at = sub;
        while (at.files.length === 0 && at.dirs.size === 1) { const [n, s] = [...at.dirs][0]; label += `/${n}`; full += `/${n}`; at = s; }
        out.push({ dir: full, label, depth });
        if (!this.folded.has(full)) walk(at, full, depth + 1);
      }
      for (const f of node.files) out.push({ file: f, depth });
    };
    walk(root, "", 0);
    return out;
  }

  filesPane(t) {
    const read = this.files.filter((f) => this.isViewed(f)).length;
    const drafted = new Set(this.draftsOf().map((d) => d.path));
    // How many comments GitHub has on each file's lines: the diff shows one file, so the list says where the talk is.
    const talks = new Map();
    for (const c of this.detail?.threads ?? []) if (!c.outdated && c.line != null) talks.set(c.path, (talks.get(c.path) ?? 0) + 1);
    const fileRow = (f, i, depth, whole) => {
      const viewed = this.isViewed(f);
      const name = whole ? f.path : f.path.split("/").pop();
      const shown = (this.view === "code" ? this.code?.path : this.file) === f.path;
      const talk = talks.get(f.path) ?? 0;
      return h_flex().id(`f-${i}-${f.path}`).h(24).flex_none().pl(4 + depth * 12).pr(8).gap(6).items_center().rounded(4).text_size(12)
        .when(shown, (el) => el.bg(t.selected))
        .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(`${f.path}\n${this.view === "code" ? L("クリックで開く・Cmd+クリックで右の列に並べて開く", "Click to open · Cmd+click to open beside, in a right column") : L("クリックでこのファイルを開く", "Click to open this file")}`)
        .on_click((e, cx) => {
          if (this.view === "code" && e?.modifiers?.platform) this.openSide(f.path, cx);
          else if (this.view === "code") { this.back = []; this.forward = []; this.candidates = null; this.openCode(f.path, cx); }
          else this.selectFile(f.path);
          cx.notify();
        })
        .child(div().id(`v-${i}-${f.path}`).w(18).h(18).flex_none().flex().items_center().justify_center().rounded(4)
          .hover((s) => s.bg(t.selected)).tooltip(viewed ? L("確認済みの印を外す（GitHub の Viewed）", "Unmark as viewed (GitHub's Viewed)") : L("確認済みにする（GitHub の Viewed）", "Mark as viewed (GitHub's Viewed)"))
          .on_click((_e, cx) => { cx.stop_propagation(); this.toggleViewed(f, cx); cx.notify(); })
          .child(div().size(11).rounded(4).border(1).border_color(viewed ? t.ansi2 : t.input).when(viewed, (el) => el.bg(t.ansi2))))
        .child(div().flex_1().min_w(0).truncate().text_color(viewed || f.generated ? t.dim : t.foreground).child(name))
        .when(f.added, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(L("追加", "Added"))))
        .when(f.deleted, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi1).child(L("削除", "Deleted"))))
        .when(f.renamed && f.add + f.del === 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(L("名前の変更", "Renamed"))))
        .when(talk > 0, (el) => el.child(div().id(`talk-${i}`).flex_none().px(4).h(15).flex().items_center().rounded(8).bg(t.raised).text_size(11).text_color(t.muted).tooltip(L(`行コメント ${talk} 件`, `${talk} line comment(s)`)).child(String(talk))))
        .when(drafted.has(f.path), (el) => el.child(ico("pencil", 12, t.accent)))
        .when(f.add > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
        .when(f.del > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
    };
    const dirRow = (d, i) => h_flex().id(`d-${i}-${d.dir}`).h(22).flex_none().pl(4 + d.depth * 12).pr(8).gap(4).items_center().rounded(4).text_size(12).text_color(t.muted)
      .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(d.dir)
      .on_click((_e, cx) => { if (this.folded.has(d.dir)) this.folded.delete(d.dir); else this.folded.add(d.dir); cx.notify(); })
      .child(ico(this.folded.has(d.dir) ? "chevron-right" : "chevron-down", 12, t.dim))
      .child(div().min_w(0).truncate().child(`${d.label}/`));
    const tree = this.fileTree();
    const generated = this.files.filter((f) => f.generated);
    return v_flex().w(this.widths.files).flex_none().min_h(0)
      .child(h_flex().h(28).flex_none().px(12).gap(8).items_center().text_size(11).text_color(t.dim).border_b(1).border_color(t.border)
        .child(div().tooltip(L("GitHub の Viewed の印", "GitHub's Viewed marks")).child(`${L("確認済み", "Viewed")} ${read} / ${this.files.length}`)))
      .child(v_flex().id("files-scroll").flex_1().min_h(0).p(4).overflow_y_scrollbar()
        .children(tree.map((x, i) => (x.dir ? dirRow(x, i) : fileRow(x.file, i, x.depth, false))))
        .when(generated.length > 0, (el) => el
          .child(div().flex_none().px(6).pt(10).pb(2).text_size(11).font_medium().text_color(t.dim).tooltip(L("ツールが書いたファイル（生成コード・ロックファイル・API 定義・スナップショットなど）", "Files a tool writes (generated code, lock files, API descriptions, snapshots)")).child(`${L("自動生成", "Generated")} ${generated.length}`))
          .children(generated.map((f, k) => fileRow(f, tree.length + k, 0, true)))));
  }

  diffRow(row, i, t) {
    const { kind } = row;
    // The + shows while the pointer is on it. It carries an id so it gets a hover state of its own;
    // the content redraws as the pointer moves along the start of the lines (below), which is what
    // lets a row of the list repaint that state.
    const plus = (on, side = "") => div().id(`plus-${i}${side}`).w(20).h(ROW_H).flex_none().flex().items_center().justify_center()
      .when(on, (e) => e.opacity(i === this.hoverRow ? 1 : 0).rounded(R.sm).bg(t.accent).text_color(t.accent_foreground).cursor_pointer().hover((s) => s.opacity(1)).child("+"));
    if (kind === "pair") {
      // Before on the left, after on the right; a side with no line of its own stays blank.
      // A long line wraps within its half; the line number and mark stand on its first row.
      // The + at the start of a line comments on it; it shows when the pointer is on it.
      const half = (r, left) => {
        const changed = r && r.kind === (left ? "-" : "+");
        const number = !r ? "" : left ? (r.kind === "-" ? r.number : r.old) : r.number;
        const pieces = (left ? row.l : row.r).slice(0, row.lines);
        // Where each wrapped piece starts in the line, for the part of it selected.
        const starts = [];
        pieces.reduce((n, p) => { starts.push(n); return n + p.reduce((m, sg) => m + [...sg.text].length, 0); }, 0);
        return div().flex().flex_row().flex_1().min_w(0).h_full().gap(8).overflow_hidden()
          .when(changed, (e) => e.bg((left ? t.ansi1 : t.ansi2) + "18")).when(!r, (e) => e.bg(t.surface))
          .when(this.inRange(r), (e) => e.bg(t.accent + "2e"))
          .child(plus(Boolean(r), left ? "l" : "r"))
          .child(div().w(40).h(ROW_H).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
          .child(div().w(8).h(ROW_H).flex_none().text_color(left ? t.ansi1 : t.ansi2).child(changed ? r.kind : ""))
          .child(v_flex().flex_1().min_w(0).when(Boolean(r) && this.rows.length <= PLAIN_MAX, (e) => e.cursor_text()).children(pieces.map((p, k) => h_flex().h(ROW_H).flex_none().whitespace_nowrap().overflow_hidden()
            .children(p.length ? this.codeLine(p, t, r ? this.selIn(left ? "l" : "r", i, starts[k], p.reduce((m, sg) => m + [...sg.text].length, 0)) : null) : [div().child(" ")]))));
      };
      return h_flex().w_full().h(this.sizes[i]).flex_none().items_start()
        .child(half(row.left, true))
        .child(div().w(1).h_full().flex_none().bg(t.border))
        .child(half(row.right === row.left ? row.right : row.right, false));
    }
    if (kind === "@") return div().w_full().px(12).h(ROW_H).flex_none().truncate().text_color(t.dim).child(row.text);
    if (kind === "resolved") {
      const users = [...new Set(row.list.map((c) => `@${c.user}`))].join(", ");
      return h_flex().w_full().h(this.sizes[i]).flex_none().pl(58).py(4)
        .child(h_flex().w(this.commentWidth()).flex_none().h_full().px(8).gap(6).items_center().rounded(8).border(1).border_color(t.border).bg(t.surface)
          .cursor_pointer().hover((s) => s.bg(t.hover)).text_size(11).text_color(t.muted)
          .child(ico(row.open ? "chevron-down" : "chevron-right", 12, t.muted))
          .child(ico("check", 12, t.ansi2))
          .child(div().flex_none().font_bold().child(L("解決済み", "Resolved")))
          .child(div().flex_1().min_w(0).truncate().child(`${users} · ${L(`${row.list.length} 件`, `${row.list.length} comment${row.list.length === 1 ? "" : "s"}`)}`))
          .child(div().flex_none().text_color(t.dim).child(row.open ? L("クリックで閉じる", "click to fold") : L("クリックで開く", "click to open"))));
    }
    if (kind === "thread" || kind === "draft") {
      const mine = kind === "draft";
      const who = mine ? `${row.draft.reply ? L(`${row.draft.to ?? ""} への返信の下書き`, `Draft reply to ${row.draft.to ?? ""}`) : row.draft.startLine != null ? L(`${row.draft.startLine}〜${row.draft.line} 行への下書き`, `Draft on lines ${row.draft.startLine}–${row.draft.line}`) : L("下書き", "Draft")}${L("（未送信）・クリックで書き直す", " (not sent) · click to edit")}` : `${row.comment.user} · ${ago(row.comment.at)} · ${L("クリックで返信", "click to reply")}`;
      const color = mine ? t.accent : t.input;
      return h_flex().w_full().h(this.sizes[i]).flex_none().pl(mine && row.draft.reply ? 82 : 58).py(4)
        .child(v_flex().w(this.commentWidth() - (mine && row.draft.reply ? 24 : 0)).flex_none().h_full().px(8).py(4).rounded(8).border(1).border_color(color).bg(mine ? t.accent + "14" : t.surface).overflow_hidden()
          .child(div().h(18).flex_none().text_size(11).font_bold().text_color(mine ? t.accent : t.muted).child(who))
          .children(row.lines.map((line) => div().flex().flex_row().flex_none().h(COMMENT_LINE).whitespace_nowrap().overflow_hidden()
            .text_color(line.kind === "quote" ? t.muted : t.foreground)
            .when(line.kind === "quote", (el) => el.border_l(2).border_color(t.input).pl(QUOTE_PAD - 2))
            .when(line.kind === "code", (el) => el.bg(t.raised).px(6))
            .when(line.indent > 0, (el) => el.child(div().w(line.indent).flex_none()))
            .children(line.spans.length ? line.spans.map((sp) => div().flex_none()
              .when(Boolean(sp.bold), (el) => el.font_bold())
              .when(Boolean(sp.code), (el) => el.bg(t.raised).rounded(4).text_color(t.accent))
              .when(Boolean(sp.badge), (el) => { const c = TAGS.find((x) => x.id === sp.badge)?.color ?? t.dim; return el.bg(c + "40").rounded(4).text_color(t.foreground).mr(4); })
              .child(sp.text)) : [div().child(" ")]))));
    }
    return h_flex().w_full().h(ROW_H).flex_none().gap(12).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .when(this.inRange(row), (e) => e.bg(t.accent + "2e"))
      .child(plus(row.line != null))
      .child(div().w(40).flex_none().text_right().text_color(t.dim).child(row.number === undefined ? "" : String(row.number)))
      .child(div().w(8).flex_none().text_color(kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.dim).child(kind === "+" || kind === "-" ? kind : ""))
      .child(h_flex().flex_1().min_w(0).whitespace_nowrap().overflow_hidden().when(["+", "-", " "].includes(kind) && this.rows.length <= PLAIN_MAX, (e) => e.cursor_text()).children(this.codeLine(row.segs ?? [{ text: row.empty ? emptyText(row.empty) : row.text, kind: null }], t, this.selIn("one", i))));
  }

  // The bar over the diff: the shown file, and what can be done with it.
  fileBar(t) {
    const f = this.current();
    const viewed = this.isViewed(f);
    const button = (id, label, tip, on, onClick) => div().id(id).flex_none().px(8).h(22).flex().items_center().rounded(4).text_size(12)
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip).on_click(onClick).child(label);
    return h_flex().h(30).flex_none().px(8).gap(4).items_center().border_b(1).border_color(t.border).text_size(12)
      .child(button("file-prev", L("前", "Prev"), L("前のファイル", "Previous file"), false, (_e, cx) => { this.stepFile(-1); cx.notify(); }))
      .child(button("file-next", L("次", "Next"), L("次のファイル", "Next file"), false, (_e, cx) => { this.stepFile(1); cx.notify(); }))
      .child(div().flex_1().min_w(0).truncate().px(6).font_family(settings().font_family ?? "JetBrains Mono").text_color(viewed ? t.muted : t.foreground).child(f.path))
      .when(f.added, (el) => el.child(div().flex_none().px(6).rounded(4).bg(t.ansi2 + "26").text_size(11).text_color(t.ansi2).child(L("追加", "Added"))))
      .when(f.deleted, (el) => el.child(div().flex_none().px(6).rounded(4).bg(t.ansi1 + "26").text_size(11).text_color(t.ansi1).child(L("削除", "Deleted"))))
      .when(f.renamed, (el) => el.child(div().flex_none().max_w(260).truncate().text_size(11).text_color(t.muted).child(`← ${f.from ?? L("移動", "moved")}`)))
      .when(Boolean(this.mark), (el) => {
        const uses = this.markRows().length;
        return el.child(h_flex().flex_none().h(22).pl(8).pr(4).gap(4).items_center().rounded(R.sm).bg(t.accent + "26").text_size(12)
          .child(div().max_w(180).truncate().font_family(settings().font_family ?? "JetBrains Mono").text_color(t.foreground).child(this.mark))
          .child(div().text_size(11).text_color(t.muted).child(L(`${uses} 行`, `${uses} lines`)))
          .child(div().id("mark-prev").w(20).h(20).flex().items_center().justify_center().rounded(R.sm).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(L("前の使用箇所へ", "Previous use"))
            .on_click((_e, cx) => { this.stepMark(-1); cx.notify(); }).child(ico("chevron-left", 12, t.muted)))
          .child(div().id("mark-next").w(20).h(20).flex().items_center().justify_center().rounded(R.sm).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(L("次の使用箇所へ", "Next use"))
            .on_click((_e, cx) => { this.stepMark(1); cx.notify(); }).child(ico("chevron-right", 12, t.muted)))
          .child(div().id("mark-clear").w(20).h(20).flex().items_center().justify_center().rounded(R.sm).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(L("ハイライトを消す", "Clear the highlight"))
            .on_click((_e, cx) => { this.mark = null; cx.notify(); }).child(ico("x", 12, t.muted))));
      })
      .when(this.view !== "preview" && !this.mark && !this.selRange(), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(this.rows.length <= PLAIN_MAX ? L("名前をクリックでハイライト・ドラッグで文字を選択・+ でコメント（ドラッグで複数行）", "Click a name to highlight · drag to select · + to comment (drag for several lines)") : L("名前をクリックでハイライト・行頭の + でコメント", "Click a name to highlight · + at a line's start to comment"))))
      .child(this.selChip(t))
      .when(this.view !== "preview" && this.oneSided(f), (el) => el.child(div().id("file-split-off").flex_none().px(8).h(22).flex().items_center().text_size(12).text_color(t.dim)
        .tooltip(L(`${f.added ? "追加されたファイル" : f.deleted ? "削除されたファイル" : f.del === 0 ? "追加だけの変更" : "削除だけの変更"}は片側しかないので、1 列で表示します。`, `${f.added ? "An added file" : f.deleted ? "A deleted file" : f.del === 0 ? "A change with only additions" : "A change with only deletions"} has one side, so it is shown unified.`)).child(L("1 列で表示", "Unified"))))
      .when(Boolean(previewKind(f)), (el) => el.child(button("file-preview", this.view === "preview" ? L("差分に戻る", "Back to diff") : L("プレビュー", "Preview"), L("Markdown を表示して、表示の上でコメントする", "Show the Markdown and comment on what it shows"), this.view === "preview", (_e, cx) => { togglePreview(this); this.compose = null; cx.notify(); })))
      .when(this.view !== "preview" && !this.oneSided(f), (el) => el.child(button("file-split", this.split ? L("1 列にする", "Unified") : L("左右に並べる", "Split"), L("変更前と変更後を、左右に並べるか 1 列で見るか", "See before and after side by side, or unified"), this.split, (_e, cx) => { this.setSplit(!this.split); cx.notify(); })))
      .child(h_flex().id("file-viewed").flex_none().h(22).px(8).gap(6).items_center().rounded(4).cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip(viewed ? L("確認済みの印を外す（GitHub の Viewed）", "Unmark as viewed (GitHub's Viewed)") : L("確認済みにして、次のファイルへ（GitHub の Viewed）", "Mark as viewed and go to the next file (GitHub's Viewed)"))
        .on_click((_e, cx) => { this.toggleViewed(f, cx); cx.notify(); })
        .child(div().size(11).rounded(4).border(1).border_color(viewed ? t.ansi2 : t.input).when(viewed, (el) => el.bg(t.ansi2)))
        .child(div().text_color(viewed ? t.ansi2 : t.muted).child(L("確認済み", "Viewed"))));
  }

  // While text is selected: how much, and a button that copies it (as Cmd+C does).
  selChip(t) {
    const text = this.selText();
    if (!text) return div();
    return h_flex().id("sel-copy").flex_none().h(22).px(8).gap(6).items_center().rounded(R.sm).bg(t.selection).text_size(12).text_color(t.foreground)
      .cursor_pointer().hover((s) => s.opacity(0.85)).tooltip(L("選んだ文字をコピー（Cmd+C）", "Copy the selected text (Cmd+C)"))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { this.copySel(cx); cx.notify(); })
      .child(L(`${text.split("\n").length} 行を選択中`, `${text.split("\n").length} lines selected`)).child(div().font_medium().child(L("コピー", "Copy")));
  }

  // The line between two panes: drag it to resize the pane it belongs to, double-click for the usual width.
  // `dir` is +1 when dragging right widens that pane, -1 when it narrows it.
  grip(t, pane, dir) {
    return div().id(`grip-${pane}`).w(5).flex_none().self_stretch().flex().justify_center().cursor_col_resize()
      .tooltip(L("ドラッグで幅を変える（ダブルクリックで元の幅）", "Drag to resize (double-click for the usual width)"))
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        if (e.click_count >= 2) { this.widths[pane] = PANES[pane].start; save("widths", this.widths); this.drag = null; }
        else this.drag = { pane, dir, x: e.position.x, width: this.widths[pane] };
        cx.notify();
      })
      .child(div().w(this.drag?.pane === pane ? 2 : 1).h_full().bg(this.drag?.pane === pane ? t.accent : t.border));
  }

  // A resolved thread is folded until opened (in the diff and in the preview alike).
  toggleResolved(root) {
    if (this.openResolved.has(root)) this.openResolved.delete(root); else this.openResolved.add(root);
    this.rebuild();
  }

  // A press on a row of the diff. On a line: the + at its start opens the comment box for it, anywhere
  // else the name under the pointer is marked everywhere in the file (a press off any name clears it).
  // On a comment: GitHub's opens a reply, an unsent one opens for rewriting; a folded resolved thread opens.
  pressRow(i) {
    const row = this.rows[i];
    if (!row) return;
    if (row.kind === "draft") { this.startDraft(row.draft, row.index); return; }
    if (row.kind === "thread") { this.startReply(row); return; }
    if (row.kind === "resolved") { this.toggleResolved(row.root); return; }
    const x = this.pressX;
    if (x == null) return;
    let name = null, word = null;
    if (row.kind === "pair") {
      const half = ((this.pressW ?? 0) - 1) / 2, left = x < half, side = left ? row.left : row.right;
      const at = left ? x : x - half - 1;
      if (!side) return;
      if (at < PLUS_W) { if (side.line != null) this.plusPressed(side); return; }
      // The list says which row, not where in it: a wrapped line is tried piece by piece at that x.
      let before = 0;
      for (const piece of left ? row.l : row.r) {
        const text = [...side.text].slice(before).join("");
        word = wordAtX(text, at - HALF_X0);
        name = word?.name ?? null;
        if (name) { word.nth = placeOf(side.text, name, before + word.start); break; }
        before += piece.reduce((k, sg) => k + [...sg.text].length, 0);
      }
    } else if (["+", "-", " "].includes(row.kind)) {
      if (x < PLUS_W) { if (row.line != null) this.plusPressed(row); return; }
      word = wordAtX(row.text, x - ONE_X0);
      name = word?.name ?? null;
      if (word) word.nth = placeOf(row.text, name, word.start);
    } else return;
    this.diffAt = i;
    this.markWord = word;
    this.mark = name;
    this.markAt = name ? i : -1;
  }

  // The box a line comment is written in: at the foot of the diff, so the diff stays in view.
  composer(t) {
    const c = this.compose;
    const button = (id, label, strong, onClick) => div().id(id).flex_none().px(12).h(24).flex().items_center().rounded(8).text_size(12)
      .bg(strong ? t.solid : t.surface).text_color(strong ? t.solid_foreground : t.muted).border(1).border_color(t.border).cursor_pointer().hover((s) => s.opacity(0.85)).on_click(onClick).child(label);
    const tagOf = () => LABEL.exec(this.editor.value())?.[1] ?? null;
    return v_flex().h(186).flex_none().px(12).py(8).gap(6).border_t(1).border_color(t.accent).bg(t.surface)
      .when(Boolean(this.composeNote), (el) => el.child(div().flex_none().text_size(11).text_color(t.blocked).child(this.composeNote)))
      .when(!this.composeNote && !c.reply && c.index == null && this.view !== "preview", (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(L("+ をドラッグするか、Shift を押しながら別の行の + を押すと、複数行へのコメントになります。", "Drag a + across lines, or Shift-click another line's +, to comment on several lines."))))
      .child(h_flex().gap(6).items_center().text_size(11)
        .child(div().flex_none().text_color(t.muted).child(`${c.reply ? L(`${c.to ?? ""} への返信・`, `Reply to ${c.to ?? ""} · `) : ""}${c.path.split("/").pop()}:${c.startLine != null ? `${c.startLine}–${c.line}` : c.line}${c.side === "LEFT" ? L("（削除側）", " (removed side)") : ""}`))
        .child(div().w(8))
        .children(TAGS.map((tag) => {
          const on = tagOf() === tag.id;
          return h_flex().id(`tag-${tag.id}`).flex_none().pl(6).pr(8).h(20).gap(6).items_center().rounded(4)
            .bg(on ? tag.color + "40" : t.background).border(1).border_color(on ? tag.color : t.border)
            .text_color(on ? t.foreground : t.muted).cursor_pointer().hover((s) => s.bg(tag.color + "26"))
            .tooltip(on ? L("このラベルを外す", "Remove this label") : L(`先頭に ${tag.id} のバッジを付ける`, `Start with a ${tag.id} badge`))
            .on_click((_e, cx) => {
              // One label at a time: pressing another replaces it, pressing the same one removes it.
              const body = this.editor.value().replace(LABEL, "");
              this.editor.set_value(on ? body : `${tag.badge} ${body}`);
              cx.notify();
            })
            .child(div().size(8).flex_none().rounded(4).bg(tag.color))
            .child(tag.id);
        })))
      .child(div().id("composer-box").flex_1().min_h(0).rounded(8).border(1).border_color(t.input).bg(t.background).overflow_hidden()
        .on_mouse_down("left", stop).child(Editor.new(this.editor).size_full()))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(L("この Mac に下書きとして保存します。「レビューを送信」するまで GitHub には出ません。", "Saved as a draft on this Mac. Nothing reaches GitHub until you submit the review.")))
        .when(c.index != null, (el) => el.child(button("draft-drop", L("削除", "Delete"), false, (_e, cx) => { this.dropDraft(c.index); cx.notify(); })))
        .child(button("draft-cancel", L("キャンセル", "Cancel"), false, (_e, cx) => { this.compose = null; cx.notify(); }))
        .child(button("draft-save", L("保存（⌘Enter）", "Save (⌘Enter)"), true, (_e, cx) => this.saveDraft(cx))));
  }

  section(t, id, title, count, body) {
    const open = Boolean(this.open[id]);
    return v_flex().flex_none().border_b(1).border_color(t.border)
      .child(h_flex().id(`sec-${id}`).h(30).flex_none().px(12).gap(8).items_center().text_size(12).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.open[id] = !open; cx.notify(); })
        .child(ico(open ? "chevron-down" : "chevron-right", 12, t.dim))
        .child(div().font_medium().text_color(t.foreground).child(title))
        .when(count != null, (el) => el.child(div().text_color(t.dim).child(String(count)))))
      .when(open, (el) => el.child(v_flex().px(12).pb(12).gap(6).text_size(12).child(body())));
  }

  info(t) {
    const pr = this.picked, d = this.detail;
    if (!d) return div().p(16).text_size(12).text_color(t.dim).child(L("読み込み中…", "Loading…"));
    const entry = (i, who, what, text, color) => v_flex().flex_none().gap(2)
      .child(h_flex().gap(6).text_size(11).child(div().font_bold().text_color(t.foreground).child(who)).when(Boolean(what), (el) => el.child(div().text_color(color ?? t.muted).child(what))))
      .when(Boolean(text), (el) => el.child(div().text_color(t.foreground).child(TextView.markdown(`md-${pr.url}-${i}`, shownText(text, 4000)))));
    const outdated = d.threads.filter((c) => c.outdated).length;
    return v_flex().id("info-scroll").flex_1().min_h(0).overflow_y_scrollbar()
      .child(this.section(t, "people", L("担当とラベル", "Assignees and labels"), null, () => v_flex().gap(4).text_color(t.muted)
        .child(div().child(`${L("担当", "Assignees")}: ${pr.assignees.join(", ") || L("なし", "none")}`))
        .child(h_flex().gap(6).flex_wrap().child(div().child(`${L("ラベル", "Labels")}:`)).children(pr.labels.length ? pr.labels.map((l) => div().px(6).rounded(8).bg(l.color + "40").text_color(t.foreground).child(l.name)) : [div().child(L("なし", "none"))]))))
      .child(this.section(t, "body", L("本文", "Description"), null, () => shownText(d.body, 12000) ? div().text_color(t.foreground).child(TextView.markdown(`body-${pr.url}`, shownText(d.body, 12000))) : div().text_color(t.dim).child(L("本文はありません。", "No description."))))
      .child(this.section(t, "commits", L("コミット", "Commits"), d.commits.length, () => v_flex().gap(4).children(d.commits.map((c) => h_flex().gap(8)
        .child(div().flex_none().font_family(settings().font_family ?? "JetBrains Mono").text_size(11).text_color(t.dim).child(c.oid))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(c.title))))))
      .child(this.section(t, "reviews", L("レビュー", "Reviews"), d.reviews.length, () => v_flex().gap(8)
        .children(d.reviews.map((r, i) => entry(`r${i}`, r.user, r.state.toLowerCase().replace("_", " "), r.body, r.state === "APPROVED" ? t.ansi2 : r.state === "CHANGES_REQUESTED" ? t.ansi1 : t.muted)))
        .when(outdated > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(L(`古い行に付いたコメントが ${outdated} 件あります（差分には出ません。GitHub で見てください）。`, `${outdated} comment(s) on outdated lines (not in the diff; see them on GitHub).`))))
        .when(d.reviews.length === 0, (el) => el.child(div().text_color(t.dim).child(L("まだレビューはありません。", "No reviews yet."))))))
      .child(this.section(t, "talk", L("会話", "Conversation"), d.comments.length, () => v_flex().gap(8)
        .children(d.comments.map((c, i) => entry(`t${i}`, c.user, ago(c.at), c.body)))
        .when(d.comments.length === 0, (el) => el.child(div().text_color(t.dim).child(L("会話はありません。", "No conversation."))))))
      .child(this.section(t, "checks", L("チェック", "Checks"), d.checks.length, () => v_flex().gap(4).children(d.checks.map((c) => {
        const bad = /FAIL|ERROR|CANCEL|TIMED_OUT/.test(c.state), ok = /SUCCESS|NEUTRAL|SKIPPED/.test(c.state);
        return h_flex().gap(8)
          .child(ico(bad ? "x" : ok ? "check" : "circle-dot", 12, bad ? t.ansi1 : ok ? t.ansi2 : t.ansi3))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(c.name))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(c.state.toLowerCase()));
      }))));
  }

  sendPane(t) {
    const pr = this.picked;
    const drafts = this.draftsOf();
    const lost = drafts.filter((d) => !this.anchored(d)).length;
    const button = (id, label, event, color) => div().id(id).flex_1().h(30).flex().items_center().justify_center().rounded(8).text_size(12)
      .bg(this.confirm === event ? color : t.surface).text_color(this.confirm === event ? t.background : t.foreground).border(1).border_color(color)
      .cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => this.send(event, cx))
      .child(this.sending && this.confirm === event ? L("送信中…", "Sending…") : this.confirm === event ? L("もう一度押すと GitHub に送ります", "Press again to send to GitHub") : label);
    return v_flex().flex_1().min_h(0).p(12).gap(8).text_size(12)
      .child(div().flex_none().text_color(t.muted).child(L(`${pr.repoName} #${pr.number} に、行コメント ${drafts.filter((d) => !d.reply).length} 件と返信 ${drafts.filter((d) => d.reply).length} 件を、1 回のレビューとして送ります。`, `Sends ${drafts.filter((d) => !d.reply).length} line comments and ${drafts.filter((d) => d.reply).length} replies to ${pr.repoName} #${pr.number} as one review.`)))
      .when(lost > 0, (el) => el.child(div().flex_none().text_color(t.blocked).child(L(`行に貼り直せなかったコメントが ${lost} 件あります。本文の末尾にまとめて載せます。`, `${lost} comment(s) no longer fit a line; they go at the end of the summary.`))))
      .child(v_flex().id("send-drafts").flex_none().max_h(180).gap(4).overflow_y_scrollbar()
        .children(drafts.map((d, i) => h_flex().id(`sd-${i}`).flex_none().gap(6).px(8).py(6).rounded(8).bg(t.surface).border(1).border_color(t.border)
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(div().text_size(11).text_color(this.anchored(d) ? t.dim : t.blocked).truncate().child(`${d.path.split("/").pop()}:${d.line}${d.reply ? L(`・${d.to ?? ""} への返信`, ` · reply to ${d.to ?? ""}`) : ""}`))
            .child(div().truncate().text_color(t.foreground).child(d.body.split("\n")[0])))
          .child(div().id(`sdx-${i}`).w(18).h(18).flex_none().flex().items_center().justify_center().rounded(4).text_color(t.dim).cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(L("この下書きを消す", "Delete this draft")).on_click((_e, cx) => { this.dropDraft(i); cx.notify(); }).child(ico("x", 12, t.dim))))))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(L("レビューの本文（Approve だけなら空でもかまいません）", "Summary (may be empty to only approve)")))
      .child(div().id("review-body").flex_1().min_h(80).rounded(8).border(1).border_color(t.input).bg(t.background).overflow_hidden()
        .on_mouse_down("left", stop).child(Editor.new(this.reviewBody).size_full()))
      .when(Boolean(this.sendError), (el) => el.child(div().flex_none().px(8).py(6).rounded(8).bg(t.blocked + "1f").text_color(t.foreground).child(this.sendError)))
      .child(h_flex().flex_none().gap(8)
        .child(button("send-comment", L("コメントとして送る", "Comment"), "COMMENT", t.accent))
        .child(button("send-approve", L("Approve する", "Approve"), "APPROVE", t.ansi2)))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(L("送ったレビューは相手に通知され、取り消せません。マージはこの画面からはできません。", "A submitted review notifies people and can't be taken back. Merging is not done from this screen.")));
  }

  center(t) {
    const pr = this.picked;
    if (!pr) return v_flex().flex_1().min_w(0).h_full().bg(t.background).child(div().p(20).text_size(12).text_color(t.dim).child(L("左の一覧から PR を選ぶと、差分がここに出ます。", "Pick a pull request in the list on the left to see its diff here.")));
    return v_flex().flex_1().min_w(0).h_full().min_h(0).bg(t.background)
      .child(this.head(t))
      .when(Boolean(this.note), (e) => e.child(div().px(16).py(6).flex_none().text_size(12).text_color(t.blocked).child(this.note)))
      // A plain row: its panes fill its height (h_flex would centre them and let the diff collapse).
      .child(div().flex().flex_row().flex_1().min_h(0)
        .when(this.files.length > 0, (e) => e.child(this.filesPane(t)).child(this.grip(t, "files", 1)))
        .when(this.view === "code", (e) => e.child(this.codePane(t)))
        .when(this.view !== "code", (e) => e.child(v_flex().flex_1().min_w(0).min_h(0)
          .when(Boolean(this.current()), (el) => el.child(this.fileBar(t)))
          .when(this.findOpen && Boolean(this.current()), (el) => el.child(this.findBar(t)))
          .when(this.view === "preview", (el) => el.child(previewPane(this, t)))
          .when(this.view !== "preview", (el) => el.child(div().id("pr-diff-pane").flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
            .on_size_change((size, cx) => {
              if (Math.abs((this.paneW ?? 0) - size.width) < 8) return;
              this.paneW = size.width;
              this.rebuild();
              cx.notify();
            })
            // Pinned to the pane's edges: a percentage height has nothing definite to measure here.
            .child(div().id("pr-diff-x").absolute().inset_0().overflow_x_scrollbar()
              // Where the press lands across the row (the list reports only which row).
              .child(div().id("pr-diff-content").w_full().min_w(this.width).h_full()
                .on_mouse_down("left", (e) => { this.pressX = unzoom(e.local_position?.x) ?? null; this.pressW = unzoom(e.bounds?.width) ?? null; this.pressShift = Boolean(e.modifiers?.shift); })
                // Over the start of the lines (where the + is), each move of a few pixels redraws the
                // list so the + under the pointer shows; elsewhere nothing is redrawn.
                .on_mouse_move((e, cx) => {
                  const p = localOf(e);
                  if (!p) return;
                  const half = ((unzoom(e.bounds?.width) ?? 0) - 1) / 2;
                  const at = this.split ? (p.x < half ? p.x : p.x - half - 1) : p.x;
                  const key = at < PLUS_W ? `${p.x < half ? "l" : "r"}${Math.floor(p.y / 6)}` : null;
                  if (key === this.hoverKey) return;
                  this.hoverKey = key;
                  cx.notify();
                })
                // A drag that started on a + ends wherever the button is let go; so does a selection.
                .on_mouse_up("left", (_e, cx) => {
                  if (this.drag) { this.dragged = this.endDrag(); cx.notify(); }
                  if (this.sel?.active) { this.endSel(); cx.notify(); }
                })
                .when(this.rows.length <= PLAIN_MAX, (el) => el.child(v_flex().id("pr-diff").size_full().overflow_y_scroll().track_scroll(this.plainScroll)
                  .children(this.rows.map((row, i) => div().id(`dr-${pr.url}-${i}`).flex_none()
                    .on_hover((on, cx) => {
                      if (on) { this.hoverRow = i; if (this.drag) this.drag.to = i; cx.notify(); }
                      else if (this.hoverRow === i) { this.hoverRow = null; cx.notify(); }
                    })
                    .on_mouse_down("left", (e, cx) => {
                      // A press on a + starts a drag; letting go on another line makes the comment span them.
                      // A press on the text starts selecting it.
                      const x = unzoom(e.local_position?.x);
                      if (x == null || !["pair", "+", "-", " "].includes(row.kind)) { this.sel = null; cx.notify(); return; }
                      const half = ((unzoom(e.bounds?.width) ?? 0) - 1) / 2;
                      const side = row.kind === "pair" ? (x < half ? "l" : "r") : "one";
                      const at = side === "r" ? x - half - 1 : x;
                      if (at < PLUS_W) { if (this.sideOf(i, side)?.line != null) this.drag = { from: i, to: i, side }; return; }
                      this.startSel(side, i, at, unzoom(e.local_position?.y));
                      cx.notify();
                    })
                    // While selecting, the pointer over a line moves the selection's end (on the side it began).
                    .on_mouse_move((e, cx) => {
                      const s = this.sel, p = localOf(e);
                      if (!s?.active || !p) return;
                      const half = ((unzoom(e.bounds?.width) ?? 0) - 1) / 2;
                      const x = s.side === "r" ? p.x - half - 1 : s.side === "l" ? Math.min(p.x, half) : p.x;
                      if (this.moveSel(i, x, p.y)) cx.notify();
                    })
                    .on_click((_e, cx) => {
                      if (this.dragged) { this.dragged = false; return; }
                      if (this.selDone) { this.selDone = false; return; }
                      this.pressRow(i);
                      cx.notify();
                    })
                    .child(this.diffRow(row, i, t))))))
                .when(this.rows.length > PLAIN_MAX, (el) => el.child(v_virtual_list("pr-diff", this.rows.length, this.sizes, (i) => `${pr.url}-${i}`,
                (range) => this.rows.slice(range.start, range.end).map((row, k) => this.diffRow(row, range.start + k, t)))
                // Rows of a virtual list take no handlers of their own: the list reports which row was pressed.
                .on_item_click((key, cx) => { this.pressRow(Number(key.slice(key.lastIndexOf("-") + 1))); cx.notify(); })
                .track_scroll(this.diffScroll).size_full()))))
            .child(Scrollbar.vertical("pr-diff").viewport_from_layout().absolute().inset_0())
            .when(this.diffBusy, (e) => e.child(div().absolute().top(10).left(14).text_color(t.dim).child(L("差分を読み込み中…", "Loading the diff…"))))
            .when(!this.diffBusy && this.rows.length === 0 && !this.note, (e) => e.child(div().absolute().top(10).left(14).text_color(t.dim).child(L("この PR には表示できる差分がありません。", "This pull request has no diff to show."))))))
          .when(Boolean(this.compose), (e) => e.child(this.composer(t)))))
        .when(Boolean(this.side), (e) => e.child(this.grip(t, "side", -1)).child(v_flex().w(this.widths.side).flex_none().min_h(0).bg(t.chrome)
          .child(h_flex().h(28).flex_none().px(12).items_center().text_size(11).font_medium().text_color(t.dim).border_b(1).border_color(t.border)
            .child(div().flex_1().child(this.side === "info" ? L("PR の情報", "Details") : L("レビューを送信", "Submit review")))
            .child(div().id("side-close").w(18).h(18).flex().items_center().justify_center().rounded(4).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => { this.side = null; this.confirm = null; cx.notify(); }).child(ico("x", 12, t.dim))))
          .child(this.side === "info" ? this.info(t) : this.sendPane(t)))));
  }

  // ---- the bar over the Claude Code session --------------------------------

  chatHead(t) {
    const tabs = spaces().flatMap((sp) => sp.tabs.map((x) => ({ ...x, shown: sp.active && x.active }))).filter((x) => isChatTab(x.name) || x.shown);
    return h_flex().size_full().pl(6).pr(8).gap(4).items_center().bg(t.surface).border_b(1).border_color(t.border).text_size(12)
      .child(h_flex().id("chat-tabs").flex_1().min_w(0).h_full().gap(4).items_center().overflow_x_scrollbar()
        .children(tabs.map((x) => h_flex().id(`ct-${x.id}`).h(24).px(8).gap(6).flex_none().items_center().rounded(8)
          .bg(x.shown ? t.selected : t.surface).text_color(x.shown ? t.foreground : t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click(() => run("tab.select", { id: x.id }))
          .child(div().size(7).flex_none().rounded(4).when(Boolean(x.status), (el) => el.bg(t[x.status] ?? t.dim)).when(!x.status, (el) => el.border(1.5).border_color(t.dim)))
          .child(div().max_w(190).truncate().child(x.named ? x.name : `${L("ターミナル", "Terminal")} ${x.name}`))
          .when(x.shown, (el) => el.child(div().id(`ctc-${x.id}`).w(18).h(18).flex_none().flex().items_center().justify_center().rounded(4).text_size(11).text_color(t.dim)
            .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(L("このタブを閉じる（中のプログラムも終了します）", "Close this tab (its program ends too)"))
            .on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: x.id }); }).child(ico("x", 12, t.dim)))))))
      .child(div().id("chat-close").px(8).h(22).flex_none().flex().items_center().rounded(4).text_color(t.muted).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(L("右のペインを閉じる（タブは動いたままです。「Claude に聞く」でまた開きます）", "Close the right pane (the tab keeps running; Ask Claude opens it again)")).on_click(() => run("layout.hide", { id: "review-chat" })).child(ico("x", 12, t.dim)));
  }

  // A drawing that fails shows why, in place of the screen: otherwise the last frame stays up as if
  // nothing had happened (a diff that never stops "loading").
  render(cx) {
    try { return this.draw(cx); } catch (e) {
      const t = theme();
      return v_flex().size_full().p(16).gap(8).bg(t.canvas).text_size(12).text_color(t.foreground)
        .child(div().font_bold().text_color(t.blocked).child(L("レビュー画面を描けませんでした", "The review screen could not be drawn")))
        .child(div().font_family(settings().font_family ?? "JetBrains Mono").child(String(e?.stack ?? e?.message ?? e).slice(0, 1200)));
    }
  }

  draw(cx) {
    const t = theme();
    if (this.role === "chat-head") return this.chatHead(t);
    ensurePreview(this, cx);
    return div().id("review-root").flex().flex_row().size_full().min_h(0).bg(t.canvas).text_color(t.foreground)
      // Cmd+C copies the selected text while the screen itself has the keyboard (pressing on the
      // text gives it); a key pressed in an input travels up here too, and is left to the input.
      .track_focus(this.selFocus)
      .on_key_down((e, cx) => {
        if (!this.selFocus.is_focused() || !e.modifiers?.platform || e.key !== "c" || !this.selRange()) return;
        cx.stop_propagation();
        this.copySel(cx);
        cx.notify();
      })
      // A pane being dragged follows the pointer anywhere over the screen, until the button is let go.
      .on_mouse_move((e, cx) => {
        // Only a pane's edge being dragged (a drag from a + has no pane).
        if (this.drag?.pane == null) return;
        const p = PANES[this.drag.pane];
        const width = Math.round(Math.max(p.min, Math.min(p.max, this.drag.width + this.drag.dir * (e.position.x - this.drag.x))));
        if (width !== this.widths[this.drag.pane]) { this.widths[this.drag.pane] = width; cx.notify(); }
      })
      .on_mouse_up("left", (_e, cx) => {
        // A selection let go of outside the lines ends there too.
        if (this.sel?.active) { this.endSel(); cx.notify(); }
        // A drag from a + let go of outside the diff makes no comment.
        if (this.drag?.pane == null) { if (this.drag) { this.drag = null; cx.notify(); } return; }
        this.drag = null;
        save("widths", this.widths);
        cx.notify();
      })
      .child(this.list(t))
      .child(this.grip(t, "list", 1))
      .child(this.center(t));
  }
}
