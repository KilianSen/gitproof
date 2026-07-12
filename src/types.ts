export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface Commit {
  hash: string;
  authorName: string;
  authorEmail: string;
  date: Date;
  /** Hour of day (0–23) in the author's own timezone, for the punchcard. */
  localHour: number;
  /** Weekday (0=Sun…6=Sat) in the author's own timezone. */
  localWeekday: number;
  files: FileChange[];
}

export interface LanguageStat {
  language: string;
  additions: number;
  deletions: number;
  files: number;
}

export interface FileStat {
  /** Path with rename notation resolved to the final name. */
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface DirStat {
  /** Top-level path segment (e.g. `src`), or `(root)` for repo-root files. */
  dir: string;
  additions: number;
  deletions: number;
  files: number;
}

export interface CommitRef {
  shortSha: string;
  date: Date;
  subject: string;
}

export interface GraphNode {
  sha: string;
  shortSha: string;
  date: Date;
  subject: string;
  isUser: boolean;
  isMerge: boolean;
  /** Present on a squash node: how many others' commits it collapses. */
  squashCount?: number;
  /** Parents contracted to the selected node set; first entry = mainline side. */
  parents: string[];
}

export interface DayBucket {
  /** Midnight UTC of the day. */
  date: Date;
  commits: number;
  additions: number;
  deletions: number;
}

export interface ContributionStats {
  user: string;
  repoLabel: string;
  from: string;
  to: string;
  commitCount: number;
  filesTouched: number;
  additions: number;
  deletions: number;
  firstDate: Date | null;
  lastDate: Date | null;
  /** One entry per calendar day with any activity, sorted ascending. */
  days: DayBucket[];
  languages: LanguageStat[];
  /** Every changed file, most-churned first. */
  files: FileStat[];
  /** Churn grouped by top-level directory, most-churned first. */
  dirs: DirStat[];
  /** commits[weekday 0=Sun…6=Sat][hour 0–23] in author-local time. */
  punchcard: number[][];
  /** Total lines changed (add+del) per commit, for the size histogram. */
  commitSizes: number[];
  /**
   * Web base for per-file links, host-shaped so `${base}/${to}/${path}`
   * resolves (e.g. `https://github.com/o/r/blob`). Null when unknown/local.
   */
  fileBlobBase: string | null;
  /** The commits the range is bound by (`from` is exclusive, `to` inclusive). */
  fromCommit: CommitRef | null;
  toCommit: CommitRef | null;
  /** Your commits + integrating merges, contracted; newest first. */
  graph: GraphNode[];
}
