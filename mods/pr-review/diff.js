// Turning a unified diff into rows to draw, its files in the order a file tree shows them.

// A line longer than this is cut for display: generated files have lines of hundreds of kilobytes.
const MAX_COLS = 1000;
// Tabs become spaces up to the next multiple of four. The line is cut first: the pattern
// rescans a tabless tail from every position, which never ends on a very long line.
const untab = (line) => {
  const text = line.length > MAX_COLS ? `${line.slice(0, MAX_COLS)} …` : line;
  return text.includes("\t") ? text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4)) : text;
};

// Files a tool writes (generated code, lock files, API descriptions, snapshots): listed last, dimmed.
const isGenerated = (path) => /(^|\/)(__generated__|generated|gen)\/|\.pb\.go$|\.pb\.gw\.go$|\.gen\.\w+$|_gen\.go$|\.generated\.\w+$|(^|\/)mocks?\/mock\.go$|(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|go\.sum|Cargo\.lock|mise\.lock|actions\.lock)$|swagger\.json$|openapi\.(json|ya?ml)$|\.snap$|\.msw\.ts$/.test(path);
// Test code and its data (Go's _test.go and testdata/, JS's .test/.spec, folders of tests, Python's
// test_*.py, Ruby's _spec.rb, Java's and Kotlin's *Test): listed after the code they test.
const isTest = (path) => /_test\.go$|(^|\/)(testdata|__tests__|tests?|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$|_spec\.rb$|Tests?\.(java|kt)$/.test(path);
// Which group of the tree a file is in, in order: the code, its tests, what a tool wrote.
const group = (f) => (f.generated ? 2 : f.test ? 1 : 0);

/** The order a file tree shows paths in: folder by folder, a folder's subfolders before its files,
 *  each by name. */
export function treeOrder(a, b) {
  const x = a.split("/"), y = b.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    const xDir = i < x.length - 1, yDir = i < y.length - 1;
    if (xDir !== yDir) return xDir ? -1 : 1;
    return x[i].localeCompare(y[i]);
  }
  return x.length - y.length;
}

// git writes a path with non-ASCII characters (a Japanese file name) or spaces in quotes, its
// bytes as octal escapes: "b/docs/\343\201\253.md". This gives the path back as text.
function unquote(path) {
  if (!path.startsWith('"')) return path;
  // Collected as %XX and decoded in one go: this runtime has no TextEncoder or TextDecoder.
  let encoded = "";
  const body = path.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") { encoded += encodeURIComponent(body[i]); continue; }
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (octal) { encoded += `%${parseInt(octal[0], 8).toString(16).padStart(2, "0")}`; i += 3; continue; }
    const c = body[++i];
    encoded += encodeURIComponent({ n: "\n", t: "\t", r: "\r" }[c] ?? c);
  }
  try { return decodeURIComponent(encoded); } catch { return body; }
}

// The two paths of a file's first line, either of which may be quoted.
const FILE_START = /^diff --git ("a\/(?:[^"\\]|\\.)*"|a\/.*?) ("b\/(?:[^"\\]|\\.)*"|b\/.*)$/;

/** A unified diff as `{ files }`, in tree order with tests after the code and generated files last.
 *  A file is `{ path, from, renamed, added, deleted, generated, test, add, del, rows }`; a row is
 *  `{ kind, text, path, number?, side?, line?, empty? }` with kind "file", "@", "+", "-", " " or "".
 *  `side` and `line` are where GitHub puts a comment on that row; `empty` ("renamed" or "binary")
 *  stands in for a file with no lines, for the screen to say why in its own words. */
export function parseDiff(text) {
  const files = [];
  let old = 0, next = 0, file = null, inHunk = false;
  for (const line of text.split("\n")) {
    const start = FILE_START.exec(line);
    if (start) {
      file = { path: unquote(start[2]).slice(2), from: null, renamed: false, added: false, deleted: false, add: 0, del: 0, rows: [] };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) continue;
    // A file's head, up to its first hunk. Inside a hunk a line that looks like one is content.
    if (!inHunk) {
      const from = /^rename from (.*)$/.exec(line);
      if (from) { file.renamed = true; file.from = unquote(from[1]); continue; }
      if (line.startsWith("new file mode")) { file.added = true; continue; }
      if (line.startsWith("deleted file mode")) { file.deleted = true; continue; }
      if (/^(index |--- |\+\+\+ |rename to |similarity index|old mode|new mode)/.test(line)) continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) { inHunk = true; old = +hunk[1]; next = +hunk[2]; file.rows.push({ kind: "@", text: line.length > MAX_COLS ? line.slice(0, MAX_COLS) : line, path: file.path }); continue; }
    const kind = line[0];
    if (kind === "-") { file.del++; file.rows.push({ kind, number: old, side: "LEFT", line: old++, text: untab(line.slice(1)) || " ", path: file.path }); }
    else if (kind === "+") { file.add++; file.rows.push({ kind, number: next, side: "RIGHT", line: next++, text: untab(line.slice(1)) || " ", path: file.path }); }
    else if (kind === " ") { file.rows.push({ kind, number: next, old: old++, side: "RIGHT", line: next++, text: untab(line.slice(1)) || " ", path: file.path }); }
    else if (line !== "") file.rows.push({ kind: "", text: untab(line), path: file.path });
  }
  for (const f of files) {
    f.generated = isGenerated(f.path);
    f.test = !f.generated && isTest(f.path);
    // A file with no lines to show says why, instead of standing empty (`empty` is what to say, in the screen's words).
    if (f.rows.length === 0) f.rows.push({ kind: "", path: f.path, text: "", empty: f.renamed ? "renamed" : "binary" });
  }
  // Files are read as a tree shows them: the code, then its tests, then the generated ones.
  files.sort((a, b) => group(a) - group(b) || treeOrder(a.path, b.path));
  return { files };
}
