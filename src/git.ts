import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";

import { languageForPath, normalizeRenamePath } from "./languages.js";
import type {
  Commit,
  CommitRef,
  ContributionStats,
  DayBucket,
  FileChange,
  FileStat,
  GraphNode,
  LanguageStat,
} from "./types.js";

const CACHE_ROOT =
  process.env.GITPROOF_CACHE_DIR ??
  path.join(os.homedir(), ".cache", "gitproof");

/**
 * Optional comma-separated allowlist of repo URLs/patterns. Each entry is
 * matched (case-insensitively) against the raw `repo` value, the resolved clone
 * URL, and a normalized `host/path` form, as either:
 *   - a glob, if it contains a `*`  (e.g. `github.com/myorg/` + `*`)
 *   - a prefix otherwise            (`https://github.com/myorg/`, `myorg/repo`)
 * Empty/unset => allow anything. See GITPROOF_ALLOWED_REPOS in the README.
 */
const ALLOWLIST = (process.env.GITPROOF_ALLOWED_REPOS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${body}$`);
}

/** True when no allowlist is set, or some pattern matches any candidate form. */
function isRepoAllowed(candidates: string[]): boolean {
  if (ALLOWLIST.length === 0) return true;
  const cands = candidates.map((c) => c.toLowerCase());
  return ALLOWLIST.some((pat) =>
    pat.includes("*")
      ? cands.some((c) => globToRegExp(pat).test(c))
      : cands.some((c) => c.startsWith(pat)),
  );
}

/** Protocol/.git-stripped `host/path` form of a clone URL for allowlist checks. */
function normalizeRepoUrl(url: string): string {
  const ssh = /^git@([^:]+):(.+)$/.exec(url);
  if (ssh) return `${ssh[1]}/${ssh[2]!.replace(/\.git$/, "")}`;
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\.git$/, "").replace(/\/+$/, "");
  } catch {
    return url;
  }
}

export class BadRequestError extends Error {}

/** Serialize clone/fetch per cache dir so concurrent requests don't collide. */
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

interface ResolvedRepo {
  /** What we log against: either a cache dir (after clone) or a local repo. */
  kind: "remote" | "local";
  /** Clone URL for remotes. */
  url?: string;
  /** Directory git runs in. */
  dir: string;
  /** Human-readable label for the SVG header. */
  label: string;
  /** Web base for file links (`${base}/${ref}/${path}`), or null. */
  webBlobBase: string | null;
}

/**
 * Turn a clone URL into a host-shaped web base such that
 * `${base}/${ref}/${path}` is a valid file link. Supports the three common
 * public hosts; returns null for self-hosted/unknown so we render plain text.
 * `GITPROOF_WEB_BASE` overrides it (use `{path}`/`{ref}` or the base form).
 */
export function deriveWebBlobBase(url: string): string | null {
  const override = process.env.GITPROOF_WEB_BASE;
  if (override) return override.replace(/\/+$/, "");

  let host: string;
  let repoPath: string;
  const ssh = /^git@([^:]+):(.+)$/.exec(url);
  if (ssh) {
    host = ssh[1]!;
    repoPath = ssh[2]!;
  } else {
    try {
      const u = new URL(url);
      host = u.host;
      repoPath = u.pathname.replace(/^\/+/, "");
    } catch {
      return null;
    }
  }
  repoPath = repoPath.replace(/\.git$/, "").replace(/\/+$/, "");
  if (repoPath.split("/").filter(Boolean).length < 2) return null;

  switch (host) {
    case "github.com":
      return `https://github.com/${repoPath}/blob`;
    case "gitlab.com":
      return `https://gitlab.com/${repoPath}/-/blob`;
    case "bitbucket.org":
      return `https://bitbucket.org/${repoPath}/src`;
    default:
      return null;
  }
}

/**
 * Accepts:
 *   - `owner/repo`            -> https://github.com/owner/repo.git
 *   - a full git URL         -> used as-is
 *   - an existing local path  -> used in place, no clone
 */
export function resolveRepo(repo: string): ResolvedRepo {
  const raw = repo.trim();
  if (!raw) throw new BadRequestError("`repo` is required");

  const deny = () => {
    throw new BadRequestError("`repo` is not in the allowlist");
  };

  // Local path (absolute, ~, or ./relative) pointing at a real directory.
  const asPath = raw.startsWith("~")
    ? path.join(os.homedir(), raw.slice(1))
    : raw;
  if (
    (raw.startsWith("/") || raw.startsWith("~") || raw.startsWith(".")) &&
    existsSync(asPath)
  ) {
    if (!isRepoAllowed([raw, path.resolve(asPath)])) deny();
    return {
      kind: "local",
      dir: path.resolve(asPath),
      label: path.basename(path.resolve(asPath)),
      webBlobBase: process.env.GITPROOF_WEB_BASE?.replace(/\/+$/, "") ?? null,
    };
  }

  let url: string;
  let label: string;
  if (/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(raw)) {
    url = raw;
    label = raw.replace(/^https?:\/\//, "").replace(/\.git$/, "");
  } else if (/^[\w.-]+\/[\w.-]+$/.test(raw)) {
    url = `https://github.com/${raw}.git`;
    label = raw;
  } else {
    throw new BadRequestError(
      "`repo` must be owner/repo, a git URL, or an existing local path",
    );
  }

  if (!isRepoAllowed([raw, url, normalizeRepoUrl(url)])) deny();

  const hash = createHash("sha1").update(url).digest("hex").slice(0, 16);
  const dir = path.join(CACHE_ROOT, hash);
  return { kind: "remote", url, dir, label, webBlobBase: deriveWebBlobBase(url) };
}

/** Ensure a bare cache clone exists and is reasonably fresh. */
async function ensureRepo(resolved: ResolvedRepo): Promise<SimpleGit> {
  if (resolved.kind === "local") {
    return simpleGit(resolved.dir);
  }

  return withLock(resolved.dir, async () => {
    if (existsSync(path.join(resolved.dir, "HEAD"))) {
      // Already cloned — refresh refs. Best-effort: a fetch failure (offline)
      // shouldn't stop us serving from what we already have.
      const git = simpleGit(resolved.dir);
      try {
        await git.fetch(["--prune", "--tags", "origin"]);
      } catch {
        /* serve stale */
      }
      return git;
    }

    await mkdir(CACHE_ROOT, { recursive: true });
    // Bare clone: full history (needed for arbitrary commit ranges), no
    // working tree (cheap on disk for huge repos).
    await simpleGit().clone(resolved.url!, resolved.dir, ["--bare"]);
    return simpleGit(resolved.dir);
  });
}

const RECORD_SEP = "\x1e"; // ASCII record separator, unlikely in commit data.

function assertRef(ref: string, name: string): void {
  if (!ref || !/^[\w.\-/^~@{}]+$/.test(ref)) {
    throw new BadRequestError(`invalid ${name} ref`);
  }
}

/**
 * Collect the user's commits in `from..to` (from exclusive, to inclusive).
 * `user` is matched case-insensitively against author name AND email.
 */
export async function collectStats(params: {
  repo: string;
  from: string;
  to: string;
  user: string;
  squashOthers?: boolean;
}): Promise<ContributionStats> {
  const { from, to, user } = params;
  const squashOthers = params.squashOthers ?? true;
  assertRef(from, "from");
  assertRef(to, "to");
  if (!user.trim()) throw new BadRequestError("`user` is required");

  const resolved = resolveRepo(params.repo);
  const git = await ensureRepo(resolved);

  const range = `${from}..${to}`;
  const format = `${RECORD_SEP}%H|%an|%ae|%aI`;

  let raw: string;
  try {
    raw = await git.raw([
      "log",
      range,
      `--author=${user}`,
      "--regexp-ignore-case",
      "--no-merges",
      "--numstat",
      `--pretty=format:${format}`,
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Unknown revisions are user error, not server error.
    if (/unknown revision|bad revision|ambiguous argument/i.test(msg)) {
      throw new BadRequestError(
        `git could not resolve range ${range}: check the commit refs`,
      );
    }
    throw err;
  }

  const [fromCommit, toCommit, graph] = await Promise.all([
    resolveCommitRef(git, from),
    resolveCommitRef(git, to),
    buildGraph(git, range, user, squashOthers),
  ]);

  const commits = parseLog(raw);
  return aggregate({
    commits,
    user,
    from,
    to,
    repoLabel: resolved.label,
    fileBlobBase: resolved.webBlobBase,
    fromCommit,
    toCommit,
    graph,
  });
}

/**
 * Build the "your commits + integrating merges" graph for `range` (from..to):
 * take the whole range's parent DAG, keep the user's commits plus the merge
 * commits that pulled user work in, and contract everyone else's commits away
 * so edges connect the kept nodes directly. Newest first.
 */
async function buildGraph(
  git: SimpleGit,
  range: string,
  user: string,
  squashOthers: boolean,
): Promise<GraphNode[]> {
  interface Rec {
    sha: string;
    shortSha: string;
    parents: string[];
    an: string;
    ae: string;
    date: Date;
    subject: string;
  }

  let raw: string;
  try {
    raw = await git.raw([
      "log",
      range,
      `--pretty=format:%H${UNIT_SEP}%h${UNIT_SEP}%P${UNIT_SEP}%an${UNIT_SEP}%ae${UNIT_SEP}%aI${UNIT_SEP}%s`,
    ]);
  } catch {
    return [];
  }

  const recs = new Map<string, Rec>();
  const order: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [H, h, P, an, ae, aI, s] = line.split(UNIT_SEP);
    if (!H) continue;
    recs.set(H, {
      sha: H,
      shortSha: h ?? H.slice(0, 7),
      parents: P ? P.trim().split(/\s+/).filter(Boolean) : [],
      an: an ?? "",
      ae: ae ?? "",
      date: new Date(aI ?? 0),
      subject: s ?? "",
    });
    order.push(H);
  }
  if (recs.size === 0) return [];

  const inRange = (sha: string) => recs.has(sha);
  const u = user.toLowerCase();
  const isUser = (r: Rec) => r.ae.toLowerCase().includes(u) || r.an.toLowerCase().includes(u);

  // contains_user(sha): does this commit or any in-range ancestor belong to the
  // user? Iterative post-order so deep histories don't blow the stack.
  const memo = new Map<string, boolean>();
  const containsUser = (start: string): boolean => {
    if (memo.has(start)) return memo.get(start)!;
    const stack = [start];
    while (stack.length) {
      const sha = stack[stack.length - 1]!;
      const r = recs.get(sha);
      if (!r) {
        memo.set(sha, false);
        stack.pop();
        continue;
      }
      if (memo.has(sha)) {
        stack.pop();
        continue;
      }
      if (isUser(r)) {
        memo.set(sha, true);
        stack.pop();
        continue;
      }
      let pending = false;
      let res = false;
      for (const p of r.parents) {
        if (!inRange(p)) continue;
        if (memo.has(p)) res ||= memo.get(p)!;
        else {
          stack.push(p);
          pending = true;
        }
      }
      if (pending) continue;
      memo.set(sha, res);
      stack.pop();
    }
    return memo.get(start)!;
  };
  for (const sha of order) containsUser(sha);

  const userShas = new Set(order.filter((sha) => isUser(recs.get(sha)!)));
  const isMerge = (r: Rec) => r.parents.length >= 2;
  // A merge integrates user work if a non-first parent's side contains it.
  const nodeSet = new Set(userShas);
  for (const sha of order) {
    const r = recs.get(sha)!;
    if (isMerge(r) && r.parents.some((p, i) => i > 0 && inRange(p) && memo.get(p) === true)) {
      nodeSet.add(sha);
    }
  }

  // Contract: from a parent, walk through non-kept commits to the nearest kept
  // ancestors on each path, counting how many others' commits were skipped.
  // Step-capped so a pathological range can't stall.
  const STEP_CAP = 20_000;
  const nearestFrom = (startParent: string): { found: string[]; foreignShas: string[] } => {
    const found: string[] = [];
    const foreignShas: string[] = [];
    const seen = new Set<string>();
    const stack = [startParent];
    let steps = 0;
    while (stack.length && steps++ < STEP_CAP) {
      const p = stack.pop()!;
      if (!inRange(p) || seen.has(p)) continue;
      seen.add(p);
      if (nodeSet.has(p)) {
        found.push(p);
        continue;
      }
      foreignShas.push(p);
      for (const pp of recs.get(p)!.parents) stack.push(pp);
    }
    return { found, foreignShas };
  };

  // Build each kept node's contracted parents. When squashOthers is on, a run
  // of others' commits between kept nodes becomes a single "squash" node —
  // keyed by the set of commits it collapses, so a run shared by two paths
  // (e.g. a merge's mainline and the branch cut after it) is one node, not two.
  const squashNodes = new Map<string, GraphNode>();
  const squashByKey = new Map<string, string>();
  let squashSeq = 0;
  const parentsFor = (sha: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (id: string) => {
      if (!seen.has(id)) (seen.add(id), out.push(id));
    };
    for (const p of recs.get(sha)!.parents) {
      if (!inRange(p)) continue; // leaves the range → a root edge, nothing to draw
      const { found, foreignShas } = nearestFrom(p);
      if (!squashOthers || foreignShas.length === 0) {
        for (const s of found) push(s);
        continue;
      }
      if (found.length === 0) continue; // run trails off past the range boundary
      const key = [...foreignShas].sort().join(",");
      let id = squashByKey.get(key);
      if (!id) {
        id = `squash:${squashSeq++}`;
        squashByKey.set(key, id);
        const newest = Math.max(...foreignShas.map((f) => recs.get(f)!.date.getTime()));
        squashNodes.set(id, {
          sha: id,
          shortSha: "",
          date: new Date(newest),
          subject: `${foreignShas.length} commit${foreignShas.length === 1 ? "" : "s"} by others`,
          isUser: false,
          isMerge: false,
          squashCount: foreignShas.length,
          parents: found,
        });
      }
      push(id);
    }
    return out;
  };

  const kept: GraphNode[] = [...nodeSet].map((sha) => {
    const r = recs.get(sha)!;
    return {
      sha,
      shortSha: r.shortSha,
      date: r.date,
      subject: r.subject,
      isUser: userShas.has(sha),
      isMerge: isMerge(r),
      parents: parentsFor(sha),
    };
  });

  const nodes = [...kept, ...squashNodes.values()];
  nodes.sort((a, b) => b.date.getTime() - a.date.getTime());
  return nodes;
}

const UNIT_SEP = "\x1f";

/** Resolve a ref to its short sha / date / subject for the range display. */
async function resolveCommitRef(
  git: SimpleGit,
  ref: string,
): Promise<CommitRef | null> {
  try {
    const out = await git.raw([
      "log",
      "-1",
      `--format=%h${UNIT_SEP}%aI${UNIT_SEP}%s`,
      ref,
    ]);
    const [shortSha, date, subject] = out.trim().split(UNIT_SEP);
    if (!shortSha) return null;
    return { shortSha, date: new Date(date ?? 0), subject: subject ?? "" };
  } catch {
    return null;
  }
}

function parseLog(raw: string): Commit[] {
  const commits: Commit[] = [];
  let current: Commit | null = null;

  for (const line of raw.split("\n")) {
    if (line.startsWith(RECORD_SEP)) {
      const [hash, an, ae, date] = line.slice(1).split("|");
      current = {
        hash: hash ?? "",
        authorName: an ?? "",
        authorEmail: ae ?? "",
        date: new Date(date ?? 0),
        files: [],
      };
      commits.push(current);
      continue;
    }
    if (!current || !line.trim()) continue;

    // numstat: "<add>\t<del>\t<path>", binary files show "-\t-\t<path>".
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    const binary = m[1] === "-" || m[2] === "-";
    const change: FileChange = {
      additions: binary ? 0 : Number(m[1]),
      deletions: binary ? 0 : Number(m[2]),
      path: m[3]!,
      binary,
    };
    current.files.push(change);
  }
  return commits;
}

function startOfDayUTC(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

function dayKey(d: Date): string {
  return startOfDayUTC(d).toISOString().slice(0, 10);
}

function aggregate(input: {
  commits: Commit[];
  user: string;
  from: string;
  to: string;
  repoLabel: string;
  fileBlobBase: string | null;
  fromCommit: CommitRef | null;
  toCommit: CommitRef | null;
  graph: GraphNode[];
}): ContributionStats {
  const { commits, user, from, to, repoLabel, fileBlobBase, fromCommit, toCommit, graph } = input;

  let additions = 0;
  let deletions = 0;
  const fileMap = new Map<string, FileStat>();
  const langMap = new Map<string, LanguageStat & { paths: Set<string> }>();
  const dayMap = new Map<string, DayBucket>();

  let firstDate: Date | null = null;
  let lastDate: Date | null = null;

  for (const c of commits) {
    if (!firstDate || c.date < firstDate) firstDate = c.date;
    if (!lastDate || c.date > lastDate) lastDate = c.date;

    const key = dayKey(c.date);
    const bucket =
      dayMap.get(key) ??
      dayMap
        .set(key, { date: startOfDayUTC(c.date), commits: 0, additions: 0, deletions: 0 })
        .get(key)!;
    bucket.commits += 1;

    for (const f of c.files) {
      const np = normalizeRenamePath(f.path);
      additions += f.additions;
      deletions += f.deletions;
      bucket.additions += f.additions;
      bucket.deletions += f.deletions;

      const fs =
        fileMap.get(np) ??
        fileMap.set(np, { path: np, additions: 0, deletions: 0, binary: false }).get(np)!;
      fs.additions += f.additions;
      fs.deletions += f.deletions;
      fs.binary = fs.binary || f.binary;

      const lang = languageForPath(np);
      const ls =
        langMap.get(lang) ??
        langMap
          .set(lang, {
            language: lang,
            additions: 0,
            deletions: 0,
            files: 0,
            paths: new Set(),
          })
          .get(lang)!;
      ls.additions += f.additions;
      ls.deletions += f.deletions;
      ls.paths.add(np);
    }
  }

  // Active days only, ascending; the renderer fills the empty grid cells so we
  // don't ship a bucket for every zero day in a multi-month range.
  const days: DayBucket[] = [...dayMap.values()].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );

  const languages: LanguageStat[] = [...langMap.values()]
    .map((l) => ({
      language: l.language,
      additions: l.additions,
      deletions: l.deletions,
      files: l.paths.size,
    }))
    .sort(
      (a, b) => b.additions + b.deletions - (a.additions + a.deletions),
    );

  const files: FileStat[] = [...fileMap.values()].sort(
    (a, b) =>
      b.additions + b.deletions - (a.additions + a.deletions) ||
      a.path.localeCompare(b.path),
  );

  return {
    user,
    repoLabel,
    from,
    to,
    commitCount: commits.length,
    filesTouched: fileMap.size,
    additions,
    deletions,
    firstDate,
    lastDate,
    days,
    languages,
    files,
    fileBlobBase,
    fromCommit,
    toCommit,
    graph,
  };
}
