# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm install
npm run dev        # tsx watch on http://localhost:8787
npm run start      # one-shot tsx run
npm run generate -- --from <ref> --user <you> --out out.svg   # CLI/CI mode (src/cli.ts)
npm run typecheck  # tsc --noEmit (the only "test" gate — there is no test suite)
npm run build      # tsc -> dist/
npm run serve      # node dist/index.js (after build)
```

`prepare` (in package.json) also runs `tsc`, so `npm install` builds `dist/` and
`npx github:KilianSen/gitproof …` works from another repo's CI. The Dockerfile's
`npm ci` calls pass `--ignore-scripts` so that `prepare` doesn't fire before
`src/` is copied — keep that flag if you touch those lines.

There are no unit tests, no linter, and no CI. `npm run typecheck` under `strict` + `noUncheckedIndexedAccess` is the correctness gate — run it after any change. Verify behavior by hitting the endpoint (a local repo needs no network):

```sh
curl 'http://localhost:8787/gitproof.svg?repo=/abs/path/to/repo&from=<ref>&to=<ref>&user=you@example.com' -o /tmp/out.svg
```

Note the ESM/NodeNext quirk: source is `.ts` but **intra-repo imports use `.js` extensions** (e.g. `import { collectStats } from "./git.js"`). Keep this when adding files.

## Architecture

Two entry points share one pipeline: **`collectStats` (git → data) → `renderSVG` (data → SVG)**. `src/index.ts` is the Hono server (`GET /gitproof.svg` with `repo`, `from`, `to`, `user` + optional `files`, `others`); `src/cli.ts` is the static-generation mode that takes the same inputs as flags/env and writes the SVG to a file (for CI). Both are thin — new input surfaces should parse into the same `collectStats`/`renderSVG` calls, and the two must stay in sync on how `files`/`others` are parsed. `src/types.ts` holds the `ContributionStats` contract that flows between the two halves.

### Data layer — `src/git.ts`
- **Range semantics are git's `from..to`**: `from` is exclusive, `to` inclusive. `from` is **optional** — omit it and the range collapses to the single-ended `to`, the only way to include the root commit (git has no ref for "before the first commit"); `resolveRootCommitRef` then supplies the root as the displayed `from` bound. `user` matches case-insensitively against author name *and* email.
- **Repo resolution & safety**: `resolveRepo` accepts `owner/repo`, a git URL, or an existing local path. `GITPROOF_ALLOWED_REPOS` (comma-separated globs/prefixes) gates what can be cloned — unset means allow anything, so treat that as a public-exposure hazard. Any change to repo-string handling must also flow through `isRepoAllowed`.
- **Bare clone cache**: remotes are cached under `GITPROOF_CACHE_DIR` (default `~/.cache/gitproof`) as bare clones (full history, no working tree). `ensureRepo` fetches-to-refresh but **serves stale on fetch failure** (offline tolerance). Clone/fetch per cache dir is serialized through the module-level `withLock` map so concurrent requests don't collide.
- **`buildGraph` is the subsystem to understand before touching the branch graph.** It takes the whole range's parent DAG, keeps the user's commits plus the merges that integrated their work, and *contracts* everyone else's commits away so kept nodes connect directly. `containsUser` is an **iterative post-order** walk (deliberately not recursive — deep histories would blow the stack) memoized in `memo`. With `squashOthers` on, a run of others' commits between kept nodes collapses into one squash node **keyed by the sorted set of collapsed SHAs**, so a run shared by two paths (merge mainline + branch cut) stays a single node. Contraction is step-capped (`STEP_CAP`) against pathological ranges.
- Git output is parsed via ASCII separators (`RECORD_SEP` `\x1e`, `UNIT_SEP` `\x1f`) chosen to not appear in commit data; `--numstat` lines are parsed by hand (binary files show `-\t-\t<path>`).

### Render layer — `src/render.ts`
- Hand-builds one SVG string top-to-bottom, **threading a mutable `y` cursor**: each section returns `{ svg, height }` and `renderSVG` advances `y` by the returned height plus a gap. When adding/reordering a section, add its height to `y` the same way or everything below it overlaps.
- Fully self-contained by design: own background, system-font stacks, no external assets — so it renders identically on any Markdown host. Everything is dark-theme GitHub palette in the `C` object.
- `activitySection` is one block folding what used to be three sections (commits-over-time area chart, calendar, punchcard): a commit heatmap (timeline + weekday) + facts line + a commits-by-hour strip. It always renders when there are commits; the weekday×hour *joint* the old punchcard showed is intentionally dropped. File rows are wrapped in `<a>` with a transparent hit-rect for whole-row clicks; links point at `fileBlobBase` (derived per host in `git.ts`) at the `to` ref. Text budgets are computed from pixel estimates (`~6.9–7.4px`/char) — adjust these if font sizes change.
- Two sections **self-hide via data guards** (each returns `{svg:"",height:0}`, and `renderSVG` only advances `y` when `height` is truthy): the commit-size histogram needs ≥5 commits, the directory breakdown needs ≥2 touched dirs. So a card's section set depends on the input — don't assume all sections are present.
- The hour strip is author-local: `git.ts` reads the hour/weekday textually from the `%aI` string (`localHourWeekday`), because `new Date(...).getHours()` would shift to UTC/server time and misplace the bars. `punchcard`/`dirs`/`commitSizes` are all precomputed in `aggregate` — render just draws them.
- `zero commits` and `null firstDate/lastDate` are valid states that render a clean empty card, not errors.

### Server — `src/index.ts`
Thin Hono wrapper. `BadRequestError` from the data layer → **400 with an error-SVG** (bad refs/repos are user error); anything else → 500 error-SVG. `/contrib.svg` is a kept legacy alias of `/gitproof.svg`. Responses carry `Cache-Control: public, max-age=900`.

## Deployment
Docker image bundles `git`, runs the compiled server as non-root, and sets git `safe.directory=*` so host/container ownership mismatches don't block reads of mounted local repos. The bare-clone cache is a volume. Configure via the env vars above (`PORT`, `GITPROOF_CACHE_DIR`, `GITPROOF_ALLOWED_REPOS`, `GITPROOF_WEB_BASE`).
