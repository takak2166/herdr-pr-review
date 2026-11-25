// Reading a pull request's files as they are at its head commit, and finding where a name
// is defined and used, in the local clone of its repository (~/ghq/github.com/<owner>/<repo>).
// Nothing in the clone's working tree is touched: files are read out of git's objects, and
// the only write to the clone is fetching the pull request's commit when it doesn't have it yet.
// For Go, gopls finds the uses in a copy of the commit's files in a cache folder (gopls-refs.sh).

import { exec, home, appHome } from "herdr";
import * as fs from "fs/promises";
import { gh } from "./github.js";
import { languageOf, highlightLine } from "./highlight.js";
import { L } from "./i18n.js";

const NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
// Extensions searched together: a name defined in one is used from the others.
const FAMILIES = [
  { exts: ["go"], patterns: (n) => [`^func (\\([^)]+\\) )?${n}[[(]`, `^type +${n}([ []|$)`, `^[[:space:]]*(var|const) +${n}([^A-Za-z0-9_]|$)`, `^[[:space:]]+(${n}|[A-Za-z0-9_]+(, *[A-Za-z0-9_]+)*, *${n})(, *[A-Za-z0-9_]+)* *:= `,`^[[:space:]]+${n}( +[]A-Za-z0-9_.*[]+)? += `] },
  { exts: ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"], patterns: (n) => [
    `(^|[^A-Za-z0-9_$.])(function\\*?|class|interface|type|enum|const|let|var) +${n}([^A-Za-z0-9_$]|$)`,
    `^[[:space:]]*(public +|private +|protected +|static +|async +|readonly +)*${n} *(<[^>]*>)?\\([^)]*\\) *(:[^={]+)?\\{`,
  ] },
  { exts: ["proto"], patterns: (n) => [`^[[:space:]]*(message|service|enum|rpc) +${n}([^A-Za-z0-9_]|$)`] },
];
const GENERIC = (n) => [`(^|[^A-Za-z0-9_.])(def|class|func|fn|function|type|struct|interface|enum|const|let|var|message|service|rpc) +${n}([^A-Za-z0-9_]|$)`];
const ext = (path) => (path.includes(".") ? path.split(".").pop().toLowerCase() : "");

/** The word at `offset` in `text` (the selection's start when nothing is selected), or null. */
export function wordAt(text, start, end) {
  if (end > start) { const picked = text.slice(start, end).trim(); return NAME.test(picked) ? picked : null; }
  let a = start, b = start;
  while (a > 0 && /[A-Za-z0-9_$]/.test(text[a - 1])) a--;
  while (b < text.length && /[A-Za-z0-9_$]/.test(text[b])) b++;
  const word = text.slice(a, b);
  return NAME.test(word) ? word : null;
}

/** The local clone of a pull request's repository, or null when there is none. */
export async function cloneOf(pr) {
  const dir = `${home()}/ghq/github.com/${pr.repo}`;
  return (await fs.exists(`${dir}/.git`)) ? dir : null;
}

// The clone has the pull request's head commit; it is fetched when it doesn't.
async function ensureCommit(dir, pr) {
  const has = await exec("git", ["-C", dir, "cat-file", "-e", `${pr.sha}^{commit}`]);
  if (has.code === 0) return;
  const got = await exec("git", ["-C", dir, "fetch", "--quiet", "--no-tags", "origin", `pull/${pr.number}/head`], { timeout: 120000 });
  if (got.code !== 0) throw new Error(`${L("PR のコミットを取得できませんでした", "Could not fetch the pull request's commit")}: ${got.stderr.trim().split("\n")[0]}`);
}

/** One file of the pull request at its head commit, as text. From the clone when there is one, else from GitHub. */
export async function fileAt(pr, path) {
  const dir = await cloneOf(pr);
  if (dir) {
    await ensureCommit(dir, pr);
    const r = await exec("git", ["-C", dir, "show", `${pr.sha}:${path}`]);
    if (r.code !== 0) throw new Error(L(`このコミットに ${path} はありません。`, `${path} is not in this commit.`));
    return r.stdout;
  }
  return gh(["api", "-H", "Accept: application/vnd.github.raw", `repos/${pr.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${pr.sha}`]);
}

/** Where `name` is defined in the pull request's repository at its head commit:
 *  `[{ path, line, text }]`, the likeliest first (the file you are in, then its folder, tests last).
 *  `member`: the name was written after a `.`, so a variable of a function can't be it.
 *  A search by the shapes definitions take in each language -- not a type-aware one. */
export async function definitions(pr, name, fromPath, { member = false } = {}) {
  if (!NAME.test(name)) return [];
  const dir = await cloneOf(pr);
  if (!dir) throw new Error(L(`${pr.repo} のクローンが ~/ghq/github.com にないため、定義を探せません。`, `No clone of ${pr.repo} in ~/ghq/github.com, so definitions can't be looked up.`));
  await ensureCommit(dir, pr);
  const family = FAMILIES.find((f) => f.exts.includes(ext(fromPath)));
  const escaped = name.replace(/\$/g, "\\$");
  const patterns = (family?.patterns ?? GENERIC)(escaped);
  const globs = family ? family.exts.map((e) => `*.${e}`) : [];
  const go = Boolean(family?.exts.includes("go"));
  // For Go, -p also prints the top-level line each match is under (`sha:path=N=func …`), which
  // tells a function's variable from a `var (` / `const (` block's entry.
  const r = await exec("git", ["-C", dir, "grep", "-n", "-I", "-E", ...(go ? ["-p"] : []), ...patterns.flatMap((p) => ["-e", p]), pr.sha, "--", ...globs], { timeout: 60000 });
  // git grep exits 1 when nothing matches.
  if (r.code > 1) throw new Error(`git grep: ${r.stderr.trim().split("\n")[0]}`);
  const found = [];
  const under = new Map();
  for (const line of r.stdout.split("\n")) {
    const head = /^[0-9a-f]+:(.*?)=\d+=(.*)$/.exec(line);
    if (head) { under.set(head[1], head[2]); continue; }
    const m = /^[0-9a-f]+:(.*?):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    if (!/^\s/.test(m[3])) under.set(m[1], m[3]);
    // An indented match inside a function (`x := …`, `x = …`, `var x`) is a variable of that function:
    // seen only in its own file, never as a member (`v := u.v(…)` is not the method `v`), and only
    // a definition when it makes the variable, not when it gives it a new value.
    else if (go && /^func[\s(]/.test(under.get(m[1]) ?? "")) {
      if (member || m[1] !== fromPath || !(/:=/.test(m[3]) || /^\s+(var|const)\s/.test(m[3]))) continue;
    }
    found.push({ path: m[1], line: Number(m[2]), text: m[3].trim().slice(0, 160) });
  }
  return found.sort(byNearness(fromPath)).slice(0, 40);
}

// The likeliest first: the file you are in, then its folder, then the rest; tests, mocks and
// generated code after everything else. Within those, by path and line.
function byNearness(fromPath) {
  const folder = fromPath.split("/").slice(0, -1).join("/");
  const rank = (d) => (d.path === fromPath ? 0 : d.path.startsWith(`${folder}/`) ? 1 : 2) + (/(_test\.go|\.(test|spec)\.\w+|\/mock\/|\/mocks?\/|\/gen\/|\.pb\.go)/.test(d.path) ? 4 : 0);
  return (a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path) || a.line - b.line;
}

/** Who last changed line `line` (from 1) of `path` as it is at the pull request's head commit, as
 *  `git blame` tells: `{ sha, author, at (ms), summary }`, or null when the clone has no such line. */
export async function blameLine(pr, path, line) {
  const dir = await cloneOf(pr);
  if (!dir) throw new Error(L(`${pr.repo} のクローンが ~/ghq/github.com にないため、行の履歴を見られません。`, `No clone of ${pr.repo} in ~/ghq/github.com, so the line's history can't be read.`));
  await ensureCommit(dir, pr);
  const r = await exec("git", ["-C", dir, "blame", "--porcelain", "-L", `${line},${line}`, pr.sha, "--", path], { timeout: 30000 });
  if (r.code !== 0) return null;
  const lines = r.stdout.split("\n");
  const field = (key) => lines.find((l) => l.startsWith(`${key} `))?.slice(key.length + 1) ?? "";
  const sha = lines[0]?.split(" ")[0] ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) return null;
  return { sha, author: field("author"), at: Number(field("author-time")) * 1000, summary: field("summary") };
}

// At most this many places are listed for a name's uses.
const MAX_REFS = 200;

/** Where `name` is used in the pull request's repository at its head commit: every line with it as
 *  a whole word, in the files of the same language family as `fromPath` (all files when it has
 *  none), the nearest first; `{ refs: [{ path, line, text }], total }`, `total` above the list's
 *  length when it was cut. A search for the word -- it finds the name in comments and strings too,
 *  and other things of the same name. */
export async function references(pr, name, fromPath) {
  if (!NAME.test(name)) return { refs: [], total: 0 };
  const dir = await cloneOf(pr);
  if (!dir) throw new Error(L(`${pr.repo} のクローンが ~/ghq/github.com にないため、参照を探せません。`, `No clone of ${pr.repo} in ~/ghq/github.com, so uses can't be looked up.`));
  await ensureCommit(dir, pr);
  const family = FAMILIES.find((f) => f.exts.includes(ext(fromPath)));
  const globs = family ? family.exts.map((e) => `*.${e}`) : [];
  const r = await exec("git", ["-C", dir, "grep", "-n", "-I", "-w", "-F", "-e", name, pr.sha, "--", ...globs], { timeout: 60000 });
  if (r.code > 1) throw new Error(`git grep: ${r.stderr.trim().split("\n")[0]}`);
  const found = r.stdout.split("\n").filter(Boolean).map((line) => {
    const m = /^[0-9a-f]+:(.*?):(\d+):(.*)$/.exec(line);
    return m && inCode(m[3], name, languageOf(m[1])) ? { path: m[1], line: Number(m[2]), text: m[3].trim().slice(0, 160) } : null;
  }).filter(Boolean);
  return { refs: found.sort(byNearness(fromPath)).slice(0, MAX_REFS), total: found.length };
}

// Whether `name` appears in `text` as a word of code: not only inside a string or a comment, as the
// line's colors tell (a line inside a block comment that starts on an earlier line can't be told).
function inCode(text, name, lang) {
  if (!lang) return true;
  const word = new RegExp(`(?<![A-Za-z0-9_$])${name.replace(/\$/g, "\\$")}(?![A-Za-z0-9_$])`);
  return highlightLine(text, lang).segs.some((sg) => sg.kind !== "string" && sg.kind !== "comment" && word.test(sg.text));
}

// Asks gopls (gopls-refs.sh) about the name at `line` of `path`, its `nth` place on that line.
async function gopls(pr, name, path, line, mode, nth) {
  if (!NAME.test(name) || ext(path) !== "go") throw new Error(L("Go のファイルではありません", "Not a Go file"));
  const dir = await cloneOf(pr);
  if (!dir) throw new Error(L(`${pr.repo} のクローンが ~/ghq/github.com にありません`, `No clone of ${pr.repo} in ~/ghq/github.com`));
  await ensureCommit(dir, pr);
  const r = await exec("sh", [`${appHome()}/mods/pr-review/gopls-refs.sh`, dir, pr.sha, path, String(line ?? 1), name, mode, String(nth)], { timeout: 180000 });
  if (r.code === 2) throw new Error(L("gopls が見つかりません（go install golang.org/x/tools/gopls@latest で入ります）", "gopls not found (go install golang.org/x/tools/gopls@latest installs it)"));
  if (r.code !== 0) throw new Error(`gopls: ${(r.stderr.trim().split("\n").filter(Boolean).slice(-1)[0] || `exit ${r.code}`).slice(0, 200)}`);
  return r;
}

/** Where a Go name is defined, by type, as gopls finds it: `{ path, line, text }`, or null when that
 *  is outside the repository (the standard library, a module). Throws, saying why, when gopls can't
 *  say. `line` (from 1) is where the name is in `path`, `nth` which of its places on that line. */
export async function goplsDefinition(pr, name, path, line, nth = 1) {
  const r = await gopls(pr, name, path, line, "def", nth);
  const first = r.stdout.split("\n").find(Boolean);
  if (!first) return null;
  const [p, n, text] = first.split("\t");
  return { path: p, line: Number(n), text: text ?? "" };
}

/** Where a Go name is used, by type, as gopls finds it (see gopls-refs.sh): `[{ path, line, text }]`
 *  the nearest first. Throws, saying why, when gopls can't say (not installed, the code doesn't
 *  load). `line` (from 1) is where the name is in `path`; its first line there when it isn't.
 *  `nth`: which of the name's places on that line. */
export async function goplsReferences(pr, name, path, line, nth = 1) {
  const r = await gopls(pr, name, path, line, "refs", nth);
  // Each line is "<path>\t<line>\t<text>\t<how>": `how` is "" for a use found directly, "rpc <service>"
  // for a call through that service's generated gRPC client (from another service), "impl <service>"
  // for the service's own method a call lands in. A place found twice is listed once, with how it
  // was reached across services when one of the two says so.
  const byPlace = new Map();
  for (const l of r.stdout.split("\n").filter(Boolean)) {
    const cols = l.split("\t");
    const how = cols.length > 3 ? cols.pop() : "";
    const [p, n, ...text] = cols;
    const [kind, service] = how.split(" ");
    const d = { path: p, line: Number(n), text: text.join("\t"), via: kind === "rpc" || kind === "impl" ? { kind, service } : null };
    if (!d.path || !d.line) continue;
    const key = `${d.path}:${d.line}`;
    if (!byPlace.has(key) || (d.via && !byPlace.get(key).via)) byPlace.set(key, d);
  }
  return [...byPlace.values()].sort(byNearness(path));
}
