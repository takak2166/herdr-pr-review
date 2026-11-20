// Everything the review screen asks GitHub, through the `gh` CLI (so it sees what your login sees).
// Reading: lists of pull requests, one pull request's details, diff and Viewed files.
// Writing: a review with its line comments, sent when you press send, and the Viewed marks you set.

import { exec, appHome, readTextFile } from "herdr";
import { L } from "./i18n.js";
import * as fs from "fs/promises";

export async function gh(args, timeout = 60000) {
  const r = await exec("gh", args, { timeout });
  if (r.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")}: ${(r.stderr.trim().split("\n")[0] || `exit ${r.code}`).slice(0, 220)}`);
  return r.stdout;
}

const PR_FIELDS = `
  number title url isDraft updatedAt createdAt
  author { login __typename }
  repository { nameWithOwner name defaultBranchRef { name } }
  baseRefName headRefName headRefOid additions deletions changedFiles reviewDecision
  labels(first: 5) { nodes { name color } }
  assignees(first: 3) { nodes { login } }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
  viewerLatestReview { state submittedAt }
  viewerDidAuthor`;

// A page of this size: GitHub answers 502 when one query asks for too much at once.
const PAGE = 40;
const SEARCH = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: ${PAGE}, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
}`;

const slim = (n) => ({
  url: n.url,
  number: n.number,
  title: n.title,
  draft: n.isDraft,
  updatedAt: n.updatedAt,
  createdAt: n.createdAt,
  author: n.author?.login ?? "ghost",
  bot: n.author?.__typename === "Bot" || /\[bot\]$/.test(n.author?.login ?? ""),
  repo: n.repository.nameWithOwner,
  repoName: n.repository.name,
  defaultBranch: n.repository.defaultBranchRef?.name ?? "main",
  base: n.baseRefName,
  head: n.headRefName,
  sha: n.headRefOid,
  add: n.additions,
  del: n.deletions,
  files: n.changedFiles,
  decision: n.reviewDecision ?? null,
  labels: (n.labels?.nodes ?? []).map((l) => ({ name: l.name, color: `#${l.color}` })),
  assignees: (n.assignees?.nodes ?? []).map((a) => a.login),
  ci: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
  pushedAt: n.commits?.nodes?.[0]?.commit?.committedDate ?? n.updatedAt,
  myReview: n.viewerLatestReview ? { state: n.viewerLatestReview.state, at: n.viewerLatestReview.submittedAt } : null,
  mine: n.viewerDidAuthor,
});

/** Open pull requests matching a GitHub search (`is:pr is:open` is added), up to `limit`.
 *  Returns `{ prs, total }`; `total` above `prs.length` means the list was cut. */
export async function searchPrs(query, limit = 100) {
  const prs = [];
  let after = null, total = 0;
  while (prs.length < limit) {
    const args = ["api", "graphql", "-f", `query=${SEARCH}`, "-f", `q=is:pr is:open archived:false ${query}`];
    if (after) args.push("-f", `after=${after}`);
    // A 502 is GitHub giving up on a heavy page; the same page usually comes back on a second try.
    const out = await gh(args).catch((e) => (/HTTP 50[234]/.test(String(e?.message)) ? gh(args) : Promise.reject(e)));
    const data = JSON.parse(out).data.search;
    total = data.issueCount;
    for (const n of data.nodes) if (n?.url) prs.push(slim(n));
    if (!data.pageInfo.hasNextPage) break;
    after = data.pageInfo.endCursor;
  }
  return { prs: prs.slice(0, limit), total };
}

/** The parts of one pull request the list doesn't carry: its text, commits, reviews,
 *  conversation, checks, and the comments already on its lines. */
export async function prDetail(pr) {
  const [view, inline] = await Promise.all([
    gh(["pr", "view", pr.url, "--json", "body,commits,reviews,comments,statusCheckRollup,mergeable,mergeStateStatus"]),
    gh(["api", "--paginate", `repos/${pr.repo}/pulls/${pr.number}/comments?per_page=100`, "--jq",
      ".[] | {id, reply: .in_reply_to_id, path, line: (.line // .original_line), side: (.side // \"RIGHT\"), outdated: (.line == null), user: .user.login, body, at: .created_at}"]),
  ]);
  const d = JSON.parse(view);
  return {
    body: d.body ?? "",
    mergeable: d.mergeable ?? null,
    mergeState: d.mergeStateStatus ?? null,
    commits: (d.commits ?? []).map((c) => ({ oid: c.oid.slice(0, 7), title: c.messageHeadline, author: c.authors?.[0]?.login ?? c.authors?.[0]?.name ?? "", at: c.committedDate })),
    reviews: (d.reviews ?? []).filter((r) => r.state !== "PENDING").map((r) => ({ user: r.author?.login ?? "", state: r.state, body: r.body ?? "", at: r.submittedAt })),
    comments: (d.comments ?? []).map((c) => ({ user: c.author?.login ?? "", body: c.body ?? "", at: c.createdAt })),
    checks: (d.statusCheckRollup ?? []).map((c) => ({ name: c.name ?? c.context ?? "", state: c.conclusion || c.state || c.status || "" })),
    threads: inline.split("\n").filter(Boolean).map((line) => JSON.parse(line)),
  };
}

/** A pull request's diff. GitHub refuses the whole diff of a very large pull request, so that
 *  case is put together from the per-file patches instead (files without one are named only). */
export async function prDiff(pr, stage) {
  try {
    return await gh(["pr", "diff", pr.url], 120000);
  } catch (e) {
    if (!/406|maximum number of (files|lines)|too_large/i.test(String(e?.message ?? e))) throw e;
    stage(L("大きな PR のため、ファイルごとの差分を集めています…", "A large pull request: gathering the diff file by file…"));
    const out = await gh(["api", "--paginate", `repos/${pr.repo}/pulls/${pr.number}/files?per_page=100`, "--jq", ".[] | {filename, patch}"], 180000);
    // A file GitHub gives no patch for (binary, or too large) comes with no lines; the screen says so.
    return out.split("\n").filter(Boolean).map((line) => {
      const f = JSON.parse(line);
      return `diff --git a/${f.filename} b/${f.filename}${f.patch ? `\n${f.patch}` : ""}`;
    }).join("\n");
  }
}

const VIEWED = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    id
    files(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { path viewerViewedState } } } } }`;

/** The files you marked Viewed on GitHub: `{ id, viewed: Set<path> }`, `id` being the pull
 *  request's node id (for `setViewed`). A file changed since you marked it is not Viewed any more,
 *  as on GitHub. */
export async function viewedFiles(pr) {
  const [owner, name] = pr.repo.split("/");
  const viewed = new Set();
  let id = null, after = null;
  for (let page = 0; page < 40; page++) {
    const args = ["api", "graphql", "-f", `query=${VIEWED}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${pr.number}`];
    if (after) args.push("-f", `after=${after}`);
    const data = JSON.parse(await gh(args)).data.repository.pullRequest;
    id = data.id;
    for (const f of data.files.nodes) if (f.viewerViewedState === "VIEWED") viewed.add(f.path);
    if (!data.files.pageInfo.hasNextPage) break;
    after = data.files.pageInfo.endCursor;
  }
  return { id, viewed };
}

const MARK = `mutation($id: ID!, $path: String!) { markFileAsViewed(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`;
const UNMARK = `mutation($id: ID!, $path: String!) { unmarkFileAsViewed(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`;

/** Marks one file of the pull request Viewed on GitHub, or takes the mark off. Seen by you alone. */
export async function setViewed(prId, path, on) {
  await gh(["api", "graphql", "-f", `query=${on ? MARK : UNMARK}`, "-f", `id=${prId}`, "-f", `path=${path}`]);
}

const THREADS = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewThreads(first: 100) { nodes { id comments(first: 100) { nodes { databaseId } } } } } } }`;
const REPLY = `mutation($review: ID!, $thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewId: $review, pullRequestReviewThreadId: $thread, body: $body }) { comment { id } } }`;

/** Posts one review on the pull request: `event` is "COMMENT" or "APPROVE", `comments` are
 *  `{ path, line, side, body }` on lines of the diff at `pr.sha`, `replies` are `{ to, body }`
 *  where `to` is the id of a comment in the thread answered. All of it or nothing: with replies
 *  the review is first made pending (seen by you alone), the replies are added to it, and only
 *  then is it submitted; when a step fails the pending review is deleted again. */
export async function submitReview(pr, { event, body, comments, replies = [] }) {
  const dir = `${appHome()}/data/pr-review`;
  await fs.mkdir(dir, { recursive: true });
  const post = async (path, payload) => {
    const file = `${dir}/review-${Date.now()}.json`;
    await fs.writeFile(file, JSON.stringify(payload));
    try { return JSON.parse(await gh(["api", "--method", "POST", path, "--input", file], 60000)); } finally { await fs.unlink(file); }
  };
  const reviews = `repos/${pr.repo}/pulls/${pr.number}/reviews`;
  if (!replies.length) return post(reviews, { commit_id: pr.sha, event, body, comments });

  // Which thread each answered comment is in (a reply is added to a thread, not to a comment).
  const [owner, name] = pr.repo.split("/");
  const found = JSON.parse(await gh(["api", "graphql", "-f", `query=${THREADS}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${pr.number}`]));
  const threadOf = new Map();
  for (const t of found.data.repository.pullRequest.reviewThreads.nodes) for (const c of t.comments.nodes) threadOf.set(c.databaseId, t.id);
  const gone = replies.filter((r) => !threadOf.has(r.to)).length;
  if (gone) throw new Error(L(`返信先のコメントが ${gone} 件、GitHub に見つかりません（削除されたか、スレッドが多すぎます）。何も送っていません。`, `${gone} comment(s) you reply to are not on GitHub (deleted, or too many threads). Nothing was sent.`));

  const pending = await post(reviews, { commit_id: pr.sha, body, comments });
  try {
    for (const r of replies) await gh(["api", "graphql", "-f", `query=${REPLY}`, "-f", `review=${pending.node_id}`, "-f", `thread=${threadOf.get(r.to)}`, "-f", `body=${r.body}`]);
    return await post(`${reviews}/${pending.id}/events`, { event, body });
  } catch (e) {
    // Nothing has gone out yet: a pending review is yours alone. It is taken back so the next try starts clean.
    const undone = await gh(["api", "--method", "DELETE", `${reviews}/${pending.id}`]).then(() => true, () => false);
    throw new Error(`${String(e?.message ?? e)}${undone ? L("（送信前の下書きレビューは取り消しました。何も送られていません）", " (the pending review was deleted; nothing was sent)") : L("（GitHub に、あなただけに見える送信前のレビューが残っているかもしれません）", " (a pending review only you can see may be left on GitHub)")}`);
  }
}

/** Where each pull request's first-pass review was posted in Slack: a Map from the pull request's
 *  URL to its thread's URL. Read from `data/pr-review/slack-threads.jsonl`, one
 *  `{"pr": "...", "thread": "..."}` per line (a later line for the same pull request wins);
 *  the review bot appends to it. Lines that aren't that are skipped. */
export async function slackThreads() {
  const text = await readTextFile(`${appHome()}/data/pr-review/slack-threads.jsonl`);
  const map = new Map();
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let row = null;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row?.pr === "string" && /^https:\/\/[\w.-]+\.slack\.com\/archives\//.test(row?.thread ?? "")) map.set(row.pr.replace(/\/+$/, ""), row.thread);
  }
  return map;
}
