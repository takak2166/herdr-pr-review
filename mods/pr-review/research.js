// Research ("下調べ"): Claude Code reads a pull request before you do and points at two kinds of
// place in its diff, each as a candidate for a line comment, not as an explanation of the code:
//   mismatch     the code disagrees with the PR's description, a design document or ADR, or
//                another part of the code
//   unexplained  a choice a reader will ask "why" about, whose reason is in no code comment, nor
//                the description, nor a design document or ADR
// The explaining is the author's to do, in code comments or comments on their own pull request:
// on someone else's pull request a finding becomes a question to them, on your own a reminder of
// what to explain. Claude Code runs headless in the head commit's files (research.sh) with only the
// tools that read; the answer is kept per head commit in data/pr-review/research/. The documents the
// description links to on GitHub (an ADR in another repository) are read beforehand and go into the
// request, since Claude Code sees only this repository's files: what they explain needs no more.

import { exec, appHome } from "herdr";
import * as fs from "fs/promises";
import { cloneOf, ensureCommit } from "./code.js";
import { gh } from "./github.js";
import { L } from "./i18n.js";

// How much of the diff goes into the request; Claude Code reads the files for the rest.
const MAX_DIFF = 150000;
const MAX_BODY = 20000;
const MAX_FINDINGS = 12;
// The linked documents read: how many, and how much of each.
const MAX_DOCS = 5;
const MAX_DOC = 40000;
// A file shown on GitHub (`https://github.com/<owner>/<repo>/blob/<ref>/<path>`) whose path ends in
// a text document's extension; the path stops there, so "…/adr.md）" or "(…/adr.md)" leaves the
// bracket out. A ref with a slash in it (a branch `feat/x`) is read as ref `feat`, and fails.
const DOC_LINK = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/blob\/([^/\s]+)\/([^\s#?)>\]]+?\.(?:md|markdown|mdx|txt|adoc|rst))(?![\w.])/gi;
// Claude Code may read for a while on a large pull request; exec allows ten minutes at most.
const TIMEOUT = 600000;
// The model and effort Claude Code reads with, unless config.json's `research` names others.
export const RESEARCH_MODEL = "opus";
export const RESEARCH_EFFORT = "high";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// How much a finding matters, most first: `must` the code behaves wrongly once merged, `should` it
// behaves but disagrees with what is written or leaves a reader to guess, `nit` nothing goes wrong
// if it stays. The kind says what sort of place it is; this says which to read first.
export const SEVERITIES = ["must", "should", "nit"];
// A finding's place in that order; one researched before there were severities goes last.
export const severityRank = (f) => { const k = SEVERITIES.indexOf(f.severity); return k < 0 ? SEVERITIES.length : k; };

const SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["mismatch", "unexplained"] },
          severity: { type: "string", enum: SEVERITIES },
          path: { type: "string", description: "The file's path in the repository, as in the diff." },
          line: { type: "integer", description: "A line number of the file after the change, on an added or unchanged line shown in the diff." },
          title: { type: "string" },
          points: { type: "array", items: { type: "string" } },
          sources: { type: "array", items: { type: "string" } },
          comment: { type: "string" },
        },
        required: ["kind", "severity", "path", "line", "title", "points", "sources", "comment"],
      },
    },
  },
  required: ["findings"],
};

const dir = () => `${appHome()}/data/pr-review/research`;
const fileOf = (pr) => `${dir()}/${pr.repo.replace("/", "__")}__${pr.number}__${pr.sha}.json`;

/** The research kept for the pull request's head commit, or null when there is none. */
export async function readResearch(pr) {
  const path = fileOf(pr);
  if (!(await fs.exists(path))) return null;
  return JSON.parse(await fs.readFile(path, "utf8"));
}

/**
 * The documents the description links to on GitHub (design documents, ADRs), as they are at the
 * linked ref, through gh: `[{ url, repo, ref, path, text }]`, or `error` in place of `text` when one
 * can't be read (no access, gone). The first MAX_DOCS, each once.
 */
export async function linkedDocs(body) {
  const docs = [];
  for (const m of body.matchAll(DOC_LINK)) {
    if (docs.length >= MAX_DOCS) break;
    const [url, repo, ref, raw] = m;
    // GitHub shows a path with non-ASCII letters percent-encoded; people paste either.
    const path = /%[0-9A-Fa-f]{2}/.test(raw) ? decodeURIComponent(raw) : raw;
    if (docs.some((d) => d.repo === repo && d.ref === ref && d.path === path)) continue;
    const doc = { url, repo, ref, path };
    try {
      doc.text = await gh(["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`]);
    } catch (e) {
      doc.error = String(e?.message ?? e);
    }
    docs.push(doc);
  }
  return docs;
}

function docsPart(docs) {
  if (!docs.length) return "";
  const one = (d) => {
    const head = `### ${d.repo} ${d.path}（${d.ref}）`;
    if (d.error) return `${head}\n${L(`（読めませんでした: ${d.error}）`, `(could not be read: ${d.error})`)}`;
    const cut = d.text.length > MAX_DOC ? `${d.text.slice(0, MAX_DOC)}\n${L("…（残りは省略）", "… (the rest is left out)")}` : d.text;
    return `${head}\n${cut}`;
  };
  return `\n\n${L("## PR からリンクされた文書", "## Documents the description links to")}\n${docs.map(one).join("\n\n")}`;
}

function request(pr, { body, diff, mine, docs }) {
  const cut = diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n${L("…（差分の残りは省略。必要ならファイルを読んでください）", "… (the rest of the diff is left out; read the files when needed)")}` : diff;
  const linked = docsPart(docs);
  const unread = docs.some((d) => d.error);
  return L(
    `あなたは Pull Request のレビューの下調べをします。今いるフォルダは、この PR の head のコミットのファイル一式です。Read・Grep・Glob でファイルを読めます。

PR: ${pr.url}
題: ${pr.title}
作者: ${pr.author}${mine ? "（このレビュー画面を使っている本人の PR）" : ""}

## PR の本文
${body || "（本文なし）"}${linked}

## 差分
${cut}

## やること
差分の中から、次の 2 種類の場所を探してください。
- mismatch: コードが、PR の本文・設計書や ADR（リポジトリにあるものと、PR からリンクされたもの）・コードのほかの場所と食い違っているところ。例: 設計書の条件と実装の条件が違う、同じ値がほかの場所にもあって片方だけ変わっている、検査を通らない経路がある。
- unexplained: 読み手が「なぜこうしたのか」と疑問に思う選択で、その理由がコードのコメントにも、PR の本文にも、設計書や ADR（リポジトリにあるものと、PR からリンクされたもの）にも書かれていないところ。例: 根拠の分からない数値、珍しい条件、消した振る舞い、回避策。

設計書や ADR は、上の「PR からリンクされた文書」と、リポジトリの docs/・adr/・design.md・README・CLAUDE.md などを Grep や Glob で探して読んでください。設計書や ADR に理由が書いてあれば、それで説明は足りています。コードのコメントや PR で書き直すことを求めないでください。${unread ? "\n\n読めなかった文書があります。その文書で決めていそうなこと（設定値・時刻・回数・方式の理由など）は、unexplained にしないでください。" : ""}

書かないもの: 書き方の好み、一般論の助言、コードがしていることの言い換え、すでにコメント・本文・設計書や ADR で説明されていること。見つからなければ findings は空で構いません。多くても ${MAX_FINDINGS} 件、must・should・nit の順に。

## 重さ（severity）
種類（mismatch か unexplained か）とは別に、どれだけ重いかを選んでください。
- must: マージすると動きが誤るもの。結果やデータが間違う、エラーになる、たどり着けない値や経路がある、同じ直しが要る場所の直し漏れ。理由が書かれていないだけに見えても、動きが誤るなら must。
- should: 動きは正しいが、PR の本文・設計書・コードのコメントと実装が食い違うもの、理由が書かれておらず読み手が誤解しそうなもの。
- nit: 直さなくても誰も困らないもの。名前、テストの重複や置き場所、リンクや参照の書き漏れ。

## 各項目の書き方
- path と line: 差分の中にある、変更後のファイルの行（追加された行か、差分に表示されている変更のない行）の行番号。削除された行は指せません。
- title: 1 行の見出し。
- points: 何が問題か・何が書かれていないかを、2〜3 個の短い文で。
- sources: 根拠にした場所。「PR 本文」「docs/adr/00057-xxx.md「再検討する条件」」「pkg/foo/bar.go:120」のように、ファイルは節や行まで書く。リンクされた文書は「owner/repo docs/adr/xxx.md「節」」のように。unexplained で根拠がないときは、探したが説明が見つからなかった場所。
- comment: ${mine
      ? "この PR の作者（本人）が、ここに何を書き足すべきかのメモ。「〜の理由をコードコメントで書く」「〜をセルフコメントで補足する」のように、書くべき内容を具体的に。理由そのものを推測で書かないこと。"
      : "作者に送る行コメントの下書き。丁寧な日本語で、質問か確認の形にする。答えを決めつけないこと。"}

日本語で書いてください。`,
    `You are researching a pull request ahead of its review. The current folder holds the files of the pull request's head commit; Read, Grep and Glob read them.

Pull request: ${pr.url}
Title: ${pr.title}
Author: ${pr.author}${mine ? " (the person using this review screen)" : ""}

## Description
${body || "(no description)"}${linked}

## Diff
${cut}

## What to do
Find two kinds of place in the diff:
- mismatch: the code disagrees with the description, a design document or ADR (in the repository, or linked from the description), or another part of the code. E.g. a condition differs from the design document's, a value also defined elsewhere changed in one place only, a path that skips a check.
- unexplained: a choice a reader will ask "why" about whose reason is in no code comment, nor the description, nor a design document or ADR (in the repository, or linked from the description). E.g. a number with no stated origin, an unusual condition, removed behavior, a workaround.

Read the documents linked from the description above, and look for design documents and ADRs in the repository with Grep and Glob (docs/, adr/, design.md, README, CLAUDE.md, ...). A reason written in a design document or ADR is explanation enough: don't ask for it again in a code comment or on the pull request.${unread ? "\n\nSome documents could not be read. Don't call unexplained what they are likely to decide (the reasons for settings, times, counts, approaches)." : ""}

Leave out: style preferences, general advice, restating what the code does, anything already explained in comments, the description, or a design document or ADR. An empty list is fine. At most ${MAX_FINDINGS}: must first, then should, then nit.

## Severity
Apart from the kind (mismatch or unexplained), say how much it matters:
- must: the code behaves wrongly once merged. Wrong results or data, an error, a value or path that can't be reached, a place left unfixed that needed the same fix. If it behaves wrongly it is must, even when it looks like a missing reason.
- should: it behaves, but disagrees with the description, a design document or a code comment, or its reason is missing where a reader is likely to get it wrong.
- nit: nobody is hurt if it stays. Names, duplicated or misplaced tests, a missing link or reference.

## Each finding
- path and line: a line of the file after the change that the diff shows (added, or unchanged context). Removed lines can't be pointed at.
- title: a one-line heading.
- points: two or three short sentences on what is wrong or missing.
- sources: where the grounds are: "the description", "docs/adr/00057-xxx.md 'When to revisit'", "pkg/foo/bar.go:120", files down to the section or line; a linked document as "owner/repo docs/adr/xxx.md 'Section'". For unexplained with no grounds, where you looked and found no reason.
- comment: ${mine
      ? "a note for the author (the person using this screen) on what to add here: \"explain why … in a code comment\", \"add a comment on the pull request about …\". Say what to explain; don't guess the reason."
      : "a draft line comment to the author, polite, as a question or a check. Don't presume the answer."}

Write in English.`);
}

/**
 * Asks Claude Code about the pull request and keeps the answer for its head commit.
 * `files` are the parsed diff's files: a finding on a line the diff doesn't show is left out
 * (counted in `dropped`). `model` and `effort` are passed to Claude Code as they are. Resolves with
 * `{ sha, at, mine, findings, dropped, cost, model, effort, models, docs }`, the findings most severe first (`models`: the models that
 * answered, as Claude Code reports them; `docs`: the linked documents, `{ url, read }` each).
 */
export async function runResearch(pr, { body, diff, files, mine, model = RESEARCH_MODEL, effort = RESEARCH_EFFORT }) {
  if (!EFFORTS.includes(effort)) throw new Error(L(`config.json の research.effort は ${EFFORTS.join(" / ")} のどれかにしてください（${effort}）`, `config.json's research.effort must be one of ${EFFORTS.join(" / ")} (${effort})`));
  const clone = await cloneOf(pr);
  if (!clone) throw new Error(L(`${pr.repo} のクローンが ~/ghq/github.com にありません`, `No clone of ${pr.repo} in ~/ghq/github.com`));
  await ensureCommit(clone, pr);
  const docs = await linkedDocs(body);
  await fs.mkdir(dir(), { recursive: true });
  const req = `${fileOf(pr)}.request.md`;
  await fs.writeFile(req, request(pr, { body: body.slice(0, MAX_BODY), diff, mine, docs }));
  const r = await exec("sh", [`${appHome()}/mods/pr-review/research.sh`, clone, pr.sha, req, JSON.stringify(SCHEMA), model, effort], { timeout: TIMEOUT });
  await fs.unlink(req).catch(() => {});
  if (r.code === 2) throw new Error(L("claude（Claude Code）が見つかりません", "claude (Claude Code) not found"));
  let out;
  try { out = JSON.parse(r.stdout); } catch { throw new Error(`Claude Code: ${(r.stderr.trim().split("\n").filter(Boolean).slice(-1)[0] || `exit ${r.code}`).slice(0, 200)}`); }
  if (out.is_error || !out.structured_output) throw new Error(`Claude Code: ${String(out.result ?? out.subtype ?? "no answer").slice(0, 200)}`);
  const shown = (f) => files.some((x) => x.path === f.path && x.rows.some((row) => row.side === "RIGHT" && row.line === f.line));
  // Most severe first, in Claude Code's order within each (the sort keeps it).
  const all = (out.structured_output.findings ?? []).slice(0, MAX_FINDINGS).sort((a, b) => severityRank(a) - severityRank(b));
  const findings = all.filter(shown).map((f, i) => ({ ...f, id: `${i}-${f.path}:${f.line}` }));
  const kept = { sha: pr.sha, at: new Date().toISOString(), mine, findings, dropped: all.length - findings.length, cost: out.total_cost_usd ?? null, model, effort, models: Object.keys(out.modelUsage ?? {}), docs: docs.map((d) => ({ url: d.url, read: !d.error })) };
  await fs.writeFile(fileOf(pr), JSON.stringify(kept, null, 2));
  return kept;
}
