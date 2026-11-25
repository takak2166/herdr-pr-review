# Changelog

Versions follow [Semantic Versioning](https://semver.org/). Each version is a git tag (`v0.1.0`)
with a GitHub release. To update, see [Updating](README.md#updating).

## v0.3.1 — 2026-11-25

### Fixed

- Enter in a line comment starts a new line instead of saving the draft; Cmd+Enter saves it.

## v0.3.0 — 2026-11-25

- Resolved threads are folded to one `Resolved` row, in the diff and in the preview's column; a
  click opens them.
- Go to definition (F12) for Go asks gopls first, so `u.x()` opens the method of `u`'s type. The
  word search, still the fallback, leaves out a function's own variables.
- gopls lookups go through a small helper (`lsp/main.go`, built with `go` the first time) that keeps
  gopls sessions open: after the first, a definition or the uses take well under a second instead
  of about three.
- The code view: Cmd+click a file to open it in a second column on the right. Each column keeps its
  own file, history, selection and search.
- Cmd+F opens the search, besides Ctrl+F (add `"cmd-f": "pr-review.find"` from `keys.json`).

### Fixed

- Files over 1,500 lines (a large `pb.go`) no longer show blank in the code view.

## v0.2.0 — 2026-11-24

- Markdown preview: `Preview` in the file bar draws a Markdown file block by block. Pressing a
  block opens a comment on its lines, drafted and submitted with the review like any other; the
  file's threads and drafts show on their blocks and in a column on the right.
- Mermaid diagrams in the preview, drawn locally as SVG with headless Chrome and a copy of Mermaid
  (optional; see Requirements). A click enlarges a diagram (1x to 4x), which can be dragged about.

## v0.1.0 — 2026-11-20

The first release.

- The list: `Review requests` and `My PRs` tabs (more from `config.json`), split into To review,
  To fix, Waiting and Watching; stacked pull requests under their base; a filter box with
  `review:`, `is:draft`, `ci:`, `author:`, `repo:` terms.
- The diff: one file at a time from a folder tree (generated files last), unified or split, syntax
  colors, GitHub's Viewed marks.
- Comments: line and multi-line comments (drag from a `+`), replies, review labels, all drafted
  locally and submitted as one review (Comment or Approve).
- The code view: go to definition (F12), find uses (Shift+F12; for Go by type with gopls, and across
  gRPC services), blame of the current line, search (Ctrl+F), text selection and copy.
- Ask Claude: built-in Review and Diagram questions (or yours from `config.json`) and a free input,
  in a Claude Code pane on the right.
- English and Japanese, following the Mac's language, switchable.
