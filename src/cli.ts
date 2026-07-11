#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { BadRequestError, collectStats } from "./git.js";
import { renderSVG } from "./render.js";

/**
 * Static-generation mode: render the SVG once and write it to a file, for use
 * in CI (generate the badge and commit it back) instead of serving it live.
 * Mirrors the query params of `GET /gitproof.svg`; every flag also has an
 * env fallback so it slots cleanly into a workflow's `env:` block.
 */

const USAGE = `gitproof — generate a contribution SVG to a file

Usage:
  gitproof --user <name|email> [options]

Options:
  --repo <owner/repo|url|path>  Repo to analyze (default: ".", the checkout).
  --from <ref>                  Start ref, exclusive. Omit for the whole
                                history, root commit included.
  --to <ref>                    End ref, inclusive (default: "HEAD").
  --user <name|email>           Author to match, case-insensitive. [required]
  --out, -o <file>              Output path (default: "gitproof.svg").
  --files <N|all>               Cap the file list to N (default: all).
  --others <hide|squash>        Others' commits in the graph (default: squash).
  --help, -h                    Show this help.

Every flag falls back to an env var: GITPROOF_REPO, GITPROOF_FROM, GITPROOF_TO,
GITPROOF_USER, GITPROOF_OUT, GITPROOF_FILES, GITPROOF_OTHERS.

Examples:
  gitproof --user me@uni.edu --out docs/contrib.svg          # whole repo
  gitproof --from v1.0.0 --to HEAD --user me@uni.edu          # a range`;

function fail(msg: string): never {
  console.error(`gitproof: ${msg}\n`);
  console.error(USAGE);
  process.exit(1);
}

async function main(): Promise<void> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      options: {
        repo: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        user: { type: "string" },
        out: { type: "string", short: "o" },
        files: { type: "string" },
        others: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const env = process.env;
  const repo = (values.repo as string) ?? env.GITPROOF_REPO ?? ".";
  const from = (values.from as string) ?? env.GITPROOF_FROM ?? "";
  const to = (values.to as string) ?? env.GITPROOF_TO ?? "HEAD";
  const user = (values.user as string) ?? env.GITPROOF_USER ?? "";
  const out = (values.out as string) ?? env.GITPROOF_OUT ?? "gitproof.svg";
  const filesRaw = (values.files as string) ?? env.GITPROOF_FILES;
  const othersRaw = (values.others as string) ?? env.GITPROOF_OTHERS;

  // `--from` is optional: omitted means the whole history (root included).
  if (!user) fail("`--user` is required");

  // Same parsing rules as the HTTP handler in index.ts.
  const maxFiles =
    filesRaw && filesRaw !== "all" && Number.isFinite(Number(filesRaw))
      ? Math.max(1, Math.floor(Number(filesRaw)))
      : undefined;
  const squashOthers = othersRaw !== "hide";

  try {
    const stats = await collectStats({ repo, from, to, user, squashOthers });
    const svg = renderSVG(stats, { maxFiles });

    const outPath = path.resolve(out);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, svg, "utf8");

    const { commitCount, filesTouched } = stats;
    console.log(
      `gitproof: wrote ${out} — ${commitCount} commit${
        commitCount === 1 ? "" : "s"
      }, ${filesTouched} file${filesTouched === 1 ? "" : "s"} for ${user}`,
    );
  } catch (err) {
    if (err instanceof BadRequestError) fail(err.message);
    throw err;
  }
}

main().catch((err) => {
  console.error("gitproof:", err instanceof Error ? err.message : err);
  process.exit(1);
});
