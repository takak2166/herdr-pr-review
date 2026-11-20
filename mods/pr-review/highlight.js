// Colors for code in the diff: a small tokenizer per language family, line by line. It knows
// keywords, strings, comments, numbers, calls and capitalised names -- not the grammar -- and
// carries one thing across lines: being inside a block comment or a multi-line string.

const GO = "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var";
const JS = "abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in instanceof interface is keyof let namespace new of private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield";
const PROTO = "syntax package import option message service rpc returns enum oneof map repeated optional required reserved stream extend";
const PY = "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield";
const SH = "if then else elif fi for while until do done case esac in function return local export readonly set unset";
const SQL = "select from where and or not insert into values update set delete create table index alter drop join left right inner outer on group by order having limit as distinct union all null is in exists between like";
const CONSTANTS = new Set("true false nil null undefined None True False iota NaN Infinity".split(" "));

const LANGS = {
  go: { keywords: GO, line: "//", block: true, raw: "`", capType: true },
  js: { keywords: JS, line: "//", block: true, raw: "`", capType: true },
  proto: { keywords: PROTO, line: "//", block: true, capType: true },
  py: { keywords: PY, line: "#" },
  sh: { keywords: SH, line: "#" },
  yaml: { keywords: "", line: "#", keys: true },
  toml: { keywords: "", line: "#", keys: true },
  json: { keywords: "", keys: true },
  sql: { keywords: SQL, line: "--", block: true, nocase: true },
  rs: { keywords: "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while", line: "//", block: true, capType: true },
};
const BY_EXT = {
  go: "go", ts: "js", tsx: "js", js: "js", jsx: "js", mjs: "js", cjs: "js", mts: "js", cts: "js",
  proto: "proto", py: "py", sh: "sh", bash: "sh", zsh: "sh", yaml: "yaml", yml: "yaml", toml: "toml",
  json: "json", jsonc: "json", sql: "sql", rs: "rs",
};
for (const l of Object.values(LANGS)) l.set = new Set(l.nocase ? l.keywords.toUpperCase().split(" ") : l.keywords.split(" "));

/** The language family of a path, or null when its code isn't colored. */
export const languageOf = (path) => BY_EXT[(path.split(".").pop() ?? "").toLowerCase()] ?? null;

/** One line's pieces: `[{ text, kind }]` with kind null, "keyword", "string", "comment", "number",
 *  "function", "type" or "constant". `state` is what the line before left open ("block" or a
 *  string's quote); the returned `state` is what this line leaves open. */
export function highlightLine(text, lang, state = null) {
  const L = LANGS[lang];
  if (!L) return { segs: [{ text, kind: null }], state: null };
  const segs = [];
  const add = (s, kind) => { if (!s) return; const last = segs.at(-1); if (last && last.kind === kind) last.text += s; else segs.push({ text: s, kind }); };
  let i = 0;
  // What the previous line left open.
  if (state === "block") {
    const end = text.indexOf("*/");
    if (end < 0) return { segs: [{ text, kind: "comment" }], state: "block" };
    add(text.slice(0, end + 2), "comment"); i = end + 2; state = null;
  } else if (state) {
    const end = text.indexOf(state);
    if (end < 0) return { segs: [{ text, kind: "string" }], state };
    add(text.slice(0, end + 1), "string"); i = end + 1; state = null;
  }
  while (i < text.length) {
    const rest = text.slice(i);
    const c = text[i];
    if (L.line && rest.startsWith(L.line)) { add(rest, "comment"); break; }
    if (L.block && rest.startsWith("/*")) {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) { add(rest, "comment"); return { segs, state: "block" }; }
      add(text.slice(i, end + 2), "comment"); i = end + 2; continue;
    }
    if (c === '"' || c === "'" || (L.raw && c === L.raw)) {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" && c !== "`" ? 2 : 1;
      if (j >= text.length && L.raw && c === L.raw) { add(rest, "string"); return { segs, state: c }; }
      const s = text.slice(i, j + 1);
      // A quoted key (JSON, YAML) reads as a name, not a value.
      add(s, L.keys && /^\s*:/.test(text.slice(j + 1)) ? "function" : "string");
      i = j + 1; continue;
    }
    const num = /^(0[xX][0-9a-fA-F_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)\b/.exec(rest);
    if (num && !/[A-Za-z0-9_$]/.test(text[i - 1] ?? "")) { add(num[0], "number"); i += num[0].length; continue; }
    const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest);
    if (word) {
      const w = word[0], after = text.slice(i + w.length);
      const kind = CONSTANTS.has(w) ? "constant"
        : L.set.has(L.nocase ? w.toUpperCase() : w) ? "keyword"
        : L.keys && /^\s*:/.test(after) ? "function"
        : /^\s*\(/.test(after) ? "function"
        : L.capType && /^[A-Z]/.test(w) ? "type"
        : null;
      add(w, kind); i += w.length; continue;
    }
    add(c, null); i++;
  }
  return { segs, state: null };
}

/** The pieces of `segs` between character `start` and `end` (code points), for a wrapped part of a line. */
export function sliceSegs(segs, start, end) {
  const out = [];
  let at = 0;
  for (const s of segs) {
    const chars = [...s.text];
    const a = Math.max(start, at), b = Math.min(end, at + chars.length);
    if (b > a) out.push({ text: chars.slice(a - at, b - at).join(""), kind: s.kind });
    at += chars.length;
    if (at >= end) break;
  }
  return out;
}
