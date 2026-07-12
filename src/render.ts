import { LANGUAGE_COLORS } from "./languages.js";
import type { ContributionStats, DayBucket } from "./types.js";

const W = 840;
const PAD = 28;
const CONTENT_W = W - 2 * PAD;

const C = {
  bg: "#0d1117",
  panel: "#161b22",
  panelBorder: "#30363d",
  hair: "#21262d",
  strong: "#e6edf3",
  mut: "#8b949e",
  dim: "#6e7681",
  green: "#3fb950",
  red: "#f85149",
  blue: "#58a6ff",
};

// Single-quote multi-word font names: these strings live inside double-quoted
// XML attributes, so embedded double quotes would break attribute parsing.
const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

const DAY_MS = 86_400_000;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function commas(n: number): string {
  return n.toLocaleString("en-US");
}

/** 12.4k style for tight spaces. */
function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function shortDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function langColor(lang: string): string {
  return LANGUAGE_COLORS[lang] ?? LANGUAGE_COLORS.Other!;
}

function text(
  x: number,
  y: number,
  s: string,
  opts: {
    size?: number;
    fill?: string;
    weight?: number;
    anchor?: "start" | "middle" | "end";
    font?: string;
    spacing?: number;
  } = {},
): string {
  const {
    size = 13,
    fill = C.strong,
    weight = 400,
    anchor = "start",
    font = FONT,
    spacing,
  } = opts;
  return `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${
    spacing != null ? ` letter-spacing="${spacing}"` : ""
  }>${esc(s)}</text>`;
}

function sectionLabel(x: number, y: number, s: string): string {
  return text(x, y, s.toUpperCase(), {
    size: 11,
    fill: C.dim,
    weight: 600,
    spacing: 0.8,
  });
}

// ---------------------------------------------------------------------------
// Stat tiles
// ---------------------------------------------------------------------------

function tile(
  x: number,
  y: number,
  w: number,
  h: number,
  value: string,
  label: string,
  color: string,
): string {
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${C.panel}" stroke="${C.panelBorder}"/>
    ${text(x + 16, y + 37, value, { size: 25, weight: 700, fill: color, font: MONO })}
    <circle cx="${x + 20}" cy="${y + 54}" r="3" fill="${color}"/>
    ${text(x + 30, y + 58, label, { size: 11, fill: C.mut, weight: 500, spacing: 0.3 })}`;
}

function tiles(y: number, stats: ContributionStats): string {
  const gap = 14;
  const w = (CONTENT_W - 3 * gap) / 4;
  const h = 76;
  const at = (i: number) => PAD + i * (w + gap);
  return (
    tile(at(0), y, w, h, commas(stats.commitCount), "Commits", C.strong) +
    tile(at(1), y, w, h, commas(stats.filesTouched), "Files changed", C.blue) +
    tile(at(2), y, w, h, `+${compact(stats.additions)}`, "Lines added", C.green) +
    tile(at(3), y, w, h, `−${compact(stats.deletions)}`, "Lines removed", C.red)
  );
}

// ---------------------------------------------------------------------------
// Commits over time (area chart) + at-a-glance activity facts
// ---------------------------------------------------------------------------

function sundayOnOrBefore(d: Date): Date {
  const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  out.setUTCDate(out.getUTCDate() - out.getUTCDay());
  return out;
}

function startOfDayMs(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

interface ActivityFacts {
  activeDays: number;
  busiest: DayBucket;
  longest: number;
}

function activityFacts(stats: ContributionStats): ActivityFacts | null {
  if (stats.days.length === 0) return null;
  let busiest = stats.days[0]!;
  for (const d of stats.days) if (d.commits > busiest.commits) busiest = d;

  const ts = stats.days.map((d) => d.date.getTime()).sort((a, b) => a - b);
  let streak = 1;
  let longest = 1;
  for (let i = 1; i < ts.length; i++) {
    streak = ts[i]! - ts[i - 1]! === DAY_MS ? streak + 1 : 1;
    if (streak > longest) longest = streak;
  }
  return { activeDays: stats.days.length, busiest, longest };
}

/** Continuous commit buckets across the range — daily if short, weekly if long. */
function buildSeries(stats: ContributionStats): {
  buckets: { t: number; count: number }[];
  byWeek: boolean;
} {
  const counts = new Map<number, number>();
  for (const d of stats.days) counts.set(startOfDayMs(d.date), d.commits);

  const first = startOfDayMs(stats.firstDate!);
  const last = startOfDayMs(stats.lastDate!);
  const byWeek = (last - first) / DAY_MS > 35;

  const buckets: { t: number; count: number }[] = [];
  if (byWeek) {
    const end = sundayOnOrBefore(stats.lastDate!).getTime();
    for (let t = sundayOnOrBefore(stats.firstDate!).getTime(); t <= end; t += 7 * DAY_MS) {
      let c = 0;
      for (let k = 0; k < 7; k++) c += counts.get(t + k * DAY_MS) ?? 0;
      buckets.push({ t, count: c });
    }
  } else {
    for (let t = first; t <= last; t += DAY_MS) buckets.push({ t, count: counts.get(t) ?? 0 });
  }
  return { buckets, byWeek };
}

function commitsChart(y: number, stats: ContributionStats): { svg: string; height: number } {
  if (!stats.firstDate || !stats.lastDate) return { svg: "", height: 0 };

  const { buckets, byWeek } = buildSeries(stats);
  const n = buckets.length;
  const chartH = 96;
  const top = y;
  const bottom = y + chartH;
  const left = PAD;
  const w = CONTENT_W;
  const maxC = Math.max(1, ...buckets.map((b) => b.count));
  const headroom = 12;

  const xAt = (i: number) => (n <= 1 ? left + w / 2 : left + (i / (n - 1)) * w);
  const yAt = (c: number) => bottom - (c / maxC) * (chartH - headroom);

  const pts = buckets.map((b, i) => [xAt(i), yAt(b.count)] as const);
  const linePath = pts.map(([x, yy], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${yy.toFixed(1)}`).join(" ");
  const areaPath =
    `M${xAt(0).toFixed(1)} ${bottom} ` +
    pts.map(([x, yy]) => `L${x.toFixed(1)} ${yy.toFixed(1)}`).join(" ") +
    ` L${xAt(n - 1).toFixed(1)} ${bottom} Z`;

  const grad = `<linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${C.green}" stop-opacity="0.32"/>
    <stop offset="1" stop-color="${C.green}" stop-opacity="0.02"/></linearGradient>`;
  const baseline = `<line x1="${left}" y1="${bottom}" x2="${left + w}" y2="${bottom}" stroke="${C.hair}"/>`;
  const area = `<path d="${areaPath}" fill="url(#areaGrad)"/>`;
  const line = `<path d="${linePath}" fill="none" stroke="${C.green}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;

  const dots =
    n <= 24
      ? buckets
          .map((b, i) =>
            b.count > 0
              ? `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(b.count).toFixed(1)}" r="2.6" fill="${C.green}" stroke="${C.bg}" stroke-width="1.5"><title>${esc(
                  shortDate(new Date(b.t)),
                )}${byWeek ? " (week of)" : ""}: ${b.count} commit${b.count === 1 ? "" : "s"}</title></circle>`
              : "",
          )
          .join("")
      : "";

  let lastMonth = -1;
  const ticks = buckets
    .map((b, i) => {
      const d = new Date(b.t);
      const m = d.getUTCMonth();
      if (m === lastMonth) return "";
      lastMonth = m;
      return text(xAt(i), bottom + 16, d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }), {
        size: 10,
        fill: C.mut,
        anchor: i === 0 ? "start" : "middle",
      });
    })
    .join("");

  const peak = text(left + w, top + 8, `peak ${maxC}/${byWeek ? "wk" : "day"}`, {
    size: 10,
    fill: C.dim,
    anchor: "end",
  });

  const f = activityFacts(stats);
  // Non-breaking spaces: SVG text collapses ordinary runs of whitespace.
  const sep = `<tspan fill="${C.dim}">  ·  </tspan>`;
  const summary = f
    ? `<text x="${left}" y="${bottom + 40}" font-family="${FONT}" font-size="12" fill="${C.mut}">` +
      `<tspan fill="${C.strong}" font-weight="600">${f.activeDays}</tspan> active days${sep}` +
      `busiest <tspan fill="${C.strong}" font-weight="600">${esc(shortDate(f.busiest.date).replace(/, \d+$/, ""))}</tspan> (${f.busiest.commits})${sep}` +
      `longest streak <tspan fill="${C.strong}" font-weight="600">${f.longest}</tspan> day${f.longest === 1 ? "" : "s"}</text>`
    : "";

  return {
    svg: grad + baseline + area + line + dots + ticks + peak + summary,
    height: bottom + 40 - y + 8,
  };
}

// ---------------------------------------------------------------------------
// Commit range (the from/to bounds)
// ---------------------------------------------------------------------------

function ellipsize(s: string, budget: number): string {
  return s.length <= budget ? s : s.slice(0, Math.max(1, budget - 1)) + "…";
}

function rangeSection(y: number, stats: ContributionStats): { svg: string; height: number } {
  const { fromCommit, toCommit } = stats;
  if (!fromCommit && !toCommit) return { svg: "", height: 0 };

  const entries = [
    ["from", fromCommit, C.blue],
    ["to", toCommit, C.green],
  ] as const;
  const rowH = 24;
  const dotX = PAD + 5;
  const firstRowY = y + 20;

  const connector =
    fromCommit && toCommit
      ? `<line x1="${dotX}" y1="${firstRowY + 4}" x2="${dotX}" y2="${firstRowY + 4 + rowH}" stroke="${C.panelBorder}" stroke-width="2"/>`
      : "";

  let ry = firstRowY;
  const rows = entries
    .map(([lbl, cr, col]) => {
      const cy = ry + 8;
      ry += rowH;
      if (!cr) return "";
      const shaX = PAD + 52;
      const dateX = shaX + 66;
      const subjX = dateX + 92;
      const budget = Math.floor((PAD + CONTENT_W - subjX) / 6.9);
      return (
        `<circle cx="${dotX}" cy="${cy - 4}" r="4.5" fill="${col}"/>` +
        text(PAD + 16, cy, lbl, { size: 10, fill: C.dim }) +
        text(shaX, cy, cr.shortSha, { font: MONO, size: 12, weight: 600, fill: col }) +
        text(dateX, cy, shortDate(cr.date), { size: 11, fill: C.mut }) +
        text(subjX, cy, ellipsize(cr.subject, Math.max(16, budget)), { size: 12, fill: C.strong })
      );
    })
    .join("");

  return {
    svg: sectionLabel(PAD, y, "Commit range") + connector + rows,
    height: ry - y + 6,
  };
}

// ---------------------------------------------------------------------------
// Branch graph (your commits + integrating merges, in lanes)
// ---------------------------------------------------------------------------

const LANE_COLORS = ["#3fb950", "#58a6ff", "#a371f7", "#e3b341", "#f778ba", "#39c5cf"];

function graphSection(y: number, stats: ContributionStats): { svg: string; height: number } {
  const all = stats.graph ?? [];
  if (all.length === 0) return { svg: "", height: 0 };

  const MAX = 20;
  const shown = all.slice(0, MAX);
  const hidden = all.length - shown.length;
  const rowOf = new Map(shown.map((n, i) => [n.sha, i] as const));
  const inShown = (sha: string) => rowOf.has(sha);

  // Lane assignment, git-log --graph style: lanes flow down toward parents.
  const laneOf = new Map<string, number>();
  const lanes: (string | null)[] = [];
  const firstFree = () => {
    const i = lanes.indexOf(null);
    return i === -1 ? lanes.length : i;
  };
  const edges: { fromSha: string; toSha: string; fromLane: number; toLane: number }[] = [];

  shown.forEach((n) => {
    let lane = lanes.indexOf(n.sha);
    if (lane === -1) lane = firstFree();
    lanes[lane] = null;
    laneOf.set(n.sha, lane);

    n.parents.filter(inShown).forEach((p, idx) => {
      let target = lanes.indexOf(p);
      if (target === -1) {
        target = idx === 0 ? lane : firstFree();
        lanes[target] = p;
      }
      edges.push({ fromSha: n.sha, toSha: p, fromLane: lane, toLane: target });
    });
  });

  const numLanes = Math.max(
    1,
    ...[...laneOf.values()].map((l) => l + 1),
    ...edges.map((e) => Math.max(e.fromLane, e.toLane) + 1),
  );

  const laneGap = 16;
  const rowGap = 26;
  const gx = PAD + 6;
  const graphTop = y + 22;
  const laneX = (l: number) => gx + l * laneGap;
  const rowY = (r: number) => graphTop + r * rowGap + 6;
  const labelX = laneX(numLanes - 1) + 24;
  const dateX = PAD + CONTENT_W;
  const laneColor = (l: number) => LANE_COLORS[l % LANE_COLORS.length]!;

  const edgeSvg = edges
    .map((e) => {
      const x1 = laneX(e.fromLane);
      const y1 = rowY(rowOf.get(e.fromSha)!);
      const x2 = laneX(e.toLane);
      const y2 = rowY(rowOf.get(e.toSha)!);
      const col = laneColor(e.toLane);
      if (x1 === x2) return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="2"/>`;
      const my = (y1 + y2) / 2;
      return `<path d="M${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}" fill="none" stroke="${col}" stroke-width="2"/>`;
    })
    .join("");

  const budget = Math.floor((dateX - labelX - 70 - 66) / 6.9);
  const nodeSvg = shown
    .map((n, r) => {
      const l = laneOf.get(n.sha)!;
      const x = laneX(l);
      const yy = rowY(r);
      const col = laneColor(l);

      if (n.squashCount) {
        // Collapsed run of other contributors' commits.
        return (
          `<rect x="${x - 4.5}" y="${yy - 4.5}" width="9" height="9" rx="2" fill="${C.hair}" stroke="${C.dim}" stroke-width="1.5"/>` +
          text(labelX, yy + 4, `⋯ ${n.subject}`, { size: 12, fill: C.dim }) +
          text(dateX, yy + 4, shortDate(n.date).replace(/, \d+$/, ""), { size: 10, fill: C.dim, anchor: "end" })
        );
      }

      const marker = n.isMerge
        ? `<circle cx="${x}" cy="${yy}" r="5" fill="${C.bg}" stroke="${col}" stroke-width="2.5"/>`
        : `<circle cx="${x}" cy="${yy}" r="4.5" fill="${col}" stroke="${C.bg}" stroke-width="1.5"/>`;
      const ink = n.isUser ? C.strong : C.mut;
      return (
        marker +
        text(labelX, yy + 4, n.shortSha, { font: MONO, size: 11, weight: 600, fill: col }) +
        text(labelX + 66, yy + 4, ellipsize(n.subject, Math.max(12, budget)), { size: 12, fill: ink }) +
        text(dateX, yy + 4, shortDate(n.date).replace(/, \d+$/, ""), { size: 10, fill: C.dim, anchor: "end" })
      );
    })
    .join("");

  let rows = shown.length;
  let more = "";
  if (hidden > 0) {
    more = text(labelX, rowY(rows) + 4, `+ ${hidden} earlier commits`, { size: 11, fill: C.dim });
    rows += 1;
  }

  const hasSquash = shown.some((n) => n.squashCount);
  const legend =
    `<circle cx="${PAD + CONTENT_W - 210}" cy="${y - 4}" r="4" fill="${C.green}"/>` +
    text(PAD + CONTENT_W - 200, y, "your commit", { size: 10, fill: C.dim }) +
    `<circle cx="${PAD + CONTENT_W - 126}" cy="${y - 4}" r="4" fill="${C.bg}" stroke="${C.mut}" stroke-width="2"/>` +
    text(PAD + CONTENT_W - 116, y, "merge", { size: 10, fill: C.dim }) +
    (hasSquash
      ? `<rect x="${PAD + CONTENT_W - 66}" y="${y - 8}" width="8" height="8" rx="2" fill="${C.hair}" stroke="${C.dim}" stroke-width="1.5"/>` +
        text(PAD + CONTENT_W - 54, y, "others", { size: 10, fill: C.dim })
      : "");

  return {
    svg: sectionLabel(PAD, y, "Branch graph") + legend + edgeSvg + nodeSvg + more,
    height: graphTop + rows * rowGap + 6 - y,
  };
}

// ---------------------------------------------------------------------------
// Lines changed (slim diff bar)
// ---------------------------------------------------------------------------

function diffBar(y: number, stats: ContributionStats): { svg: string; height: number } {
  const total = stats.additions + stats.deletions;
  const w = CONTENT_W;
  const h = 8;
  const addW = total === 0 ? 0 : (stats.additions / total) * w;
  const delW = total === 0 ? 0 : w - addW;
  const barY = y + 6;
  const svg = `
    ${sectionLabel(PAD, y, "Lines changed")}
    ${text(PAD + CONTENT_W, y, "", {})}
    ${text(PAD + CONTENT_W - 74, y, `+${commas(stats.additions)}`, { size: 11, fill: C.green, font: MONO, anchor: "end" })}
    ${text(PAD + CONTENT_W, y, `−${commas(stats.deletions)}`, { size: 11, fill: C.red, font: MONO, anchor: "end" })}
    <clipPath id="diffClip"><rect x="${PAD}" y="${barY}" width="${w}" height="${h}" rx="4"/></clipPath>
    <g clip-path="url(#diffClip)">
      <rect x="${PAD}" y="${barY}" width="${w}" height="${h}" fill="${C.hair}"/>
      <rect x="${PAD}" y="${barY}" width="${addW.toFixed(1)}" height="${h}" fill="${C.green}"/>
      <rect x="${(PAD + addW + 2).toFixed(1)}" y="${barY}" width="${Math.max(0, delW - 2).toFixed(1)}" height="${h}" fill="${C.red}"/>
    </g>`;
  return { svg, height: barY + h - y };
}

// ---------------------------------------------------------------------------
// Language breakdown (stacked bar + dotted legend)
// ---------------------------------------------------------------------------

function languages(y: number, stats: ContributionStats): { svg: string; height: number } {
  const changes = (l: { additions: number; deletions: number }) => l.additions + l.deletions;
  const total = stats.languages.reduce((s, l) => s + changes(l), 0) || 1;

  const top = stats.languages.slice(0, 6);
  const restTotal = stats.languages.slice(6).reduce((s, l) => s + changes(l), 0);
  const segs = top.map((l) => ({ name: l.language, value: changes(l), files: l.files }));
  if (restTotal > 0) segs.push({ name: "Other", value: restTotal, files: 0 });

  const barY = y + 4;
  const barH = 12;
  const w = CONTENT_W;

  // Stacked segments with a 2px surface gap between fills.
  let cx = PAD;
  const segRects = segs
    .map((s, i) => {
      const raw = (s.value / total) * w;
      const segW = i === segs.length - 1 ? PAD + w - cx : Math.max(2, raw - 2);
      const rect = `<rect x="${cx.toFixed(1)}" y="${barY}" width="${segW.toFixed(1)}" height="${barH}" fill="${langColor(
        s.name,
      )}"><title>${esc(s.name)}: ${Math.round((s.value / total) * 100)}%</title></rect>`;
      cx += i === segs.length - 1 ? segW : raw;
      return rect;
    })
    .join("");
  const bar = `
    <clipPath id="langClip"><rect x="${PAD}" y="${barY}" width="${w}" height="${barH}" rx="6"/></clipPath>
    <g clip-path="url(#langClip)"><rect x="${PAD}" y="${barY}" width="${w}" height="${barH}" fill="${C.hair}"/>${segRects}</g>`;

  // Legend: dot + name + percent, laid out in up to 3 columns.
  const cols = 3;
  const colW = w / cols;
  const rowH = 22;
  const legendTop = barY + barH + 22;
  const legend = segs
    .map((s, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const lx = PAD + col * colW;
      const ly = legendTop + row * rowH;
      const pct = Math.round((s.value / total) * 100);
      return (
        `<circle cx="${lx + 4}" cy="${ly - 4}" r="5" fill="${langColor(s.name)}"/>` +
        text(lx + 16, ly, s.name, { size: 12, fill: C.strong, weight: 500 }) +
        text(lx + 16 + s.name.length * 7.4 + 8, ly, `${pct}%`, { size: 12, fill: C.mut, font: MONO })
      );
    })
    .join("");

  const rows = Math.ceil(segs.length / cols);
  const height = legendTop + (rows - 1) * rowH + 6 - y;
  return { svg: sectionLabel(PAD, y - 4, "Language breakdown") + bar + legend, height };
}

// ---------------------------------------------------------------------------
// Files changed (GitHub PR-style list)
// ---------------------------------------------------------------------------

/** Split N meter cells into green (additions) / red (deletions) / empty. */
function diffMeter(additions: number, deletions: number, cells = 5): { g: number; r: number } {
  const total = additions + deletions;
  if (total === 0) return { g: 0, r: 0 };
  let g = Math.round((additions / total) * cells);
  g = Math.max(additions > 0 ? 1 : 0, Math.min(g, deletions > 0 ? cells - 1 : cells));
  const r = deletions > 0 ? cells - g : 0;
  return { g, r };
}

function truncatePath(p: string, budget: number): string {
  if (p.length <= budget) return p;
  return "…" + p.slice(-(budget - 1));
}

function fileRow(
  y: number,
  f: { path: string; additions: number; deletions: number; binary: boolean },
  href: string | null,
): string {
  const rightEdge = PAD + CONTENT_W;
  const meterCells = 5;
  const cw = 8;
  const cg = 2;
  const meterW = meterCells * cw + (meterCells - 1) * cg;
  const meterX = rightEdge - meterW;
  const numbersX = meterX - 12;

  // Path: muted directory + strong basename, truncated from the left.
  const pathBudget = Math.floor((numbersX - 96 - PAD) / 7.1);
  const disp = truncatePath(f.path, Math.max(12, pathBudget));
  const slash = disp.lastIndexOf("/");
  const dir = slash >= 0 ? disp.slice(0, slash + 1) : "";
  const base = slash >= 0 ? disp.slice(slash + 1) : disp;
  const pathSvg = `<text x="${PAD}" y="${y}" font-family="${MONO}" font-size="12">${
    dir ? `<tspan fill="${C.mut}">${esc(dir)}</tspan>` : ""
  }<tspan fill="${C.strong}">${esc(base)}</tspan></text>`;

  const numbers = f.binary
    ? text(numbersX, y, "bin", { size: 11, fill: C.dim, font: MONO, anchor: "end" })
    : `<text x="${numbersX}" y="${y}" font-family="${MONO}" font-size="11" text-anchor="end"><tspan fill="${C.green}">+${commas(
        f.additions,
      )}</tspan> <tspan fill="${C.red}">−${commas(f.deletions)}</tspan></text>`;

  const { g, r } = diffMeter(f.additions, f.deletions, meterCells);
  const meter = Array.from({ length: meterCells }, (_, i) => {
    const fill = i < g ? C.green : i < g + r ? C.red : C.panelBorder;
    return `<rect x="${meterX + i * (cw + cg)}" y="${y - 8}" width="${cw}" height="${cw}" rx="1.5" fill="${fill}"/>`;
  }).join("");

  const row = pathSvg + numbers + meter;
  if (!href) return row;
  // Transparent hit-rect makes the whole row clickable, not just the glyphs.
  const hit = `<rect x="${PAD}" y="${y - 14}" width="${CONTENT_W}" height="20" fill="rgba(0,0,0,0)"/>`;
  const safe = esc(href);
  return `<a href="${safe}" xlink:href="${safe}" target="_blank" rel="noopener noreferrer">${row}${hit}</a>`;
}

function filesSection(
  y: number,
  stats: ContributionStats,
  maxFiles?: number,
): { svg: string; height: number } {
  const all = stats.files;
  const shown = maxFiles && all.length > maxFiles ? all.slice(0, maxFiles) : all;
  const rowH = 22;

  const header = sectionLabel(PAD, y, `Files changed (${all.length})`);
  let ry = y + 24;
  const base = stats.fileBlobBase;
  const rows = shown.map((f) => {
    const href = base
      ? `${base}/${stats.to}/${f.path.split("/").map(encodeURIComponent).join("/")}`
      : null;
    const svg = fileRow(ry + 12, f, href);
    ry += rowH;
    return svg;
  });

  let more = "";
  if (shown.length < all.length) {
    more = text(PAD, ry + 12, `+ ${all.length - shown.length} more files`, {
      size: 12,
      fill: C.dim,
    });
    ry += rowH;
  }

  return { svg: header + rows.join("") + more, height: ry - y };
}

// ---------------------------------------------------------------------------
// Commit calendar (GitHub-style weeks × weekdays heatmap)
// ---------------------------------------------------------------------------

function calendarSection(y: number, stats: ContributionStats): { svg: string; height: number } {
  if (!stats.firstDate || !stats.lastDate) return { svg: "", height: 0 };
  const first = startOfDayMs(stats.firstDate);
  const last = startOfDayMs(stats.lastDate);
  // Short ranges are already covered by the area chart above.
  if ((last - first) / DAY_MS < 10) return { svg: "", height: 0 };

  const counts = new Map<number, number>();
  for (const d of stats.days) counts.set(startOfDayMs(d.date), d.commits);
  const maxC = Math.max(1, ...stats.days.map((d) => d.commits));

  const col0 = sundayOnOrBefore(stats.firstDate).getTime();
  const colLast = sundayOnOrBefore(stats.lastDate).getTime();
  const weeks = Math.round((colLast - col0) / (7 * DAY_MS)) + 1;

  const leftPad = 34;
  const gap = 2;
  const cell = Math.max(4, Math.min(12, Math.floor((CONTENT_W - leftPad - (weeks - 1) * gap) / weeks)));
  const step = cell + gap;
  const gridX = PAD + leftPad;
  const gridTop = y + 20;

  // Additive green: darker = more commits that day, empty days stay hairline.
  const shade = (c: number) =>
    c === 0 ? C.hair : `rgba(63,185,80,${(0.28 + 0.72 * (c / maxC)).toFixed(2)})`;

  let cells = "";
  let months = "";
  for (let w = 0; w < weeks; w++) {
    const colDate = new Date(col0 + w * 7 * DAY_MS);
    // Label a month once, at the week that contains its 1st — avoids labelling
    // (and overlapping on) the stub column that trails off the previous month.
    if (colDate.getUTCDate() <= 7) {
      months += text(gridX + w * step, gridTop - 6, colDate.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }), {
        size: 9,
        fill: C.mut,
      });
    }
    for (let d = 0; d < 7; d++) {
      const t = col0 + (w * 7 + d) * DAY_MS;
      if (t < first || t > last) continue;
      const c = counts.get(t) ?? 0;
      const cx = gridX + w * step;
      const cy = gridTop + d * step;
      const title = c > 0 ? `<title>${esc(shortDate(new Date(t)))}: ${c} commit${c === 1 ? "" : "s"}</title>` : "";
      cells += `<rect x="${cx}" y="${cy}" width="${cell}" height="${cell}" rx="2" fill="${shade(c)}">${title}</rect>`;
    }
  }

  const weekdayLabels = [
    [1, "Mon"],
    [3, "Wed"],
    [5, "Fri"],
  ]
    .map(([i, l]) => text(PAD, gridTop + (i as number) * step + cell - 1, l as string, { size: 9, fill: C.mut }))
    .join("");

  return {
    svg: sectionLabel(PAD, y, "Commit calendar") + months + weekdayLabels + cells,
    height: gridTop + 7 * step - y,
  };
}

// ---------------------------------------------------------------------------
// Punchcard (weekday × hour, dot size ∝ commits)
// ---------------------------------------------------------------------------

function punchcardSection(y: number, stats: ContributionStats): { svg: string; height: number } {
  if (stats.commitCount < 5) return { svg: "", height: 0 };
  const pc = stats.punchcard ?? [];
  const max = Math.max(1, ...pc.flat());

  const leftPad = 34;
  const gridX = PAD + leftPad;
  const colW = (CONTENT_W - leftPad) / 24;
  const rowGap = 16;
  const gridTop = y + 22;
  const maxR = Math.min(colW, rowGap) / 2 - 1;
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const rowOrder = [1, 2, 3, 4, 5, 6, 0]; // Mon first, weekend at the bottom

  let dots = "";
  rowOrder.forEach((wd, ri) => {
    const cy = gridTop + ri * rowGap;
    dots += text(PAD, cy + 3, dayNames[wd] ?? "", { size: 9, fill: C.mut });
    const row = pc[wd] ?? [];
    for (let hr = 0; hr < 24; hr++) {
      const c = row[hr] ?? 0;
      if (c === 0) continue;
      const r = Math.max(1.3, Math.sqrt(c / max) * maxR);
      const cx = gridX + hr * colW + colW / 2;
      dots += `<circle cx="${cx.toFixed(1)}" cy="${cy}" r="${r.toFixed(1)}" fill="${C.green}"><title>${dayNames[wd]} ${String(hr).padStart(2, "0")}:00 — ${c} commit${c === 1 ? "" : "s"}</title></circle>`;
    }
  });

  let axis = "";
  for (const hr of [0, 6, 12, 18, 23]) {
    axis += text(gridX + hr * colW + colW / 2, gridTop + 7 * rowGap - 1, `${hr}h`, {
      size: 9,
      fill: C.dim,
      anchor: "middle",
    });
  }

  return {
    svg: sectionLabel(PAD, y, "When the commits happen") + dots + axis,
    height: gridTop + 7 * rowGap + 6 - y,
  };
}

// ---------------------------------------------------------------------------
// Where the work landed (churn by top-level directory)
// ---------------------------------------------------------------------------

function dirsSection(y: number, stats: ContributionStats): { svg: string; height: number } {
  const dirs = stats.dirs ?? [];
  if (dirs.length < 2) return { svg: "", height: 0 };

  const top = dirs.slice(0, 6);
  const rest = dirs.length - top.length;
  const max = Math.max(1, ...top.map((d) => d.additions + d.deletions));

  const labelW = 130;
  const barX = PAD + labelW;
  const numbersW = 116;
  const barMaxW = CONTENT_W - labelW - numbersW;
  const rowH = 24;

  let ry = y + 22;
  const rows = top
    .map((d) => {
      const total = d.additions + d.deletions;
      const bw = Math.max(2, (total / max) * barMaxW);
      const addW = total ? (d.additions / total) * bw : 0;
      const svg =
        text(PAD, ry + 3, ellipsize(d.dir, 20), { size: 12, fill: C.strong, font: MONO }) +
        `<clipPath id="dirClip${ry}"><rect x="${barX}" y="${ry - 6}" width="${bw.toFixed(1)}" height="10" rx="3"/></clipPath>` +
        `<g clip-path="url(#dirClip${ry})">` +
        `<rect x="${barX}" y="${ry - 6}" width="${addW.toFixed(1)}" height="10" fill="${C.green}"/>` +
        `<rect x="${(barX + addW).toFixed(1)}" y="${ry - 6}" width="${(bw - addW).toFixed(1)}" height="10" fill="${C.red}"/>` +
        `</g>` +
        `<text x="${PAD + CONTENT_W}" y="${ry + 3}" font-family="${MONO}" font-size="11" text-anchor="end"><tspan fill="${C.green}">+${compact(d.additions)}</tspan> <tspan fill="${C.red}">−${compact(d.deletions)}</tspan></text>`;
      ry += rowH;
      return svg;
    })
    .join("");

  let more = "";
  if (rest > 0) {
    more = text(PAD, ry + 3, `+ ${rest} more director${rest === 1 ? "y" : "ies"}`, { size: 11, fill: C.dim });
    ry += rowH;
  }

  return { svg: sectionLabel(PAD, y, "Where the work landed") + rows + more, height: ry - y };
}

// ---------------------------------------------------------------------------
// Commit sizes (histogram of lines changed per commit)
// ---------------------------------------------------------------------------

function commitSizeSection(y: number, stats: ContributionStats): { svg: string; height: number } {
  const sizes = stats.commitSizes ?? [];
  if (sizes.length < 5) return { svg: "", height: 0 };

  const edges = [10, 50, 200, 1000, Infinity];
  const labels = ["<10", "10–49", "50–199", "200–999", "1k+"];
  const buckets = new Array<number>(edges.length).fill(0);
  for (const s of sizes) {
    let i = edges.findIndex((e) => s < e);
    if (i < 0) i = edges.length - 1;
    buckets[i] = (buckets[i] ?? 0) + 1;
  }
  const max = Math.max(1, ...buckets);

  const n = buckets.length;
  const gap = 18;
  const barW = (CONTENT_W - (n - 1) * gap) / n;
  const chartH = 64;
  const top = y + 18;
  const base = top + chartH;

  let bars = "";
  buckets.forEach((b, i) => {
    const bx = PAD + i * (barW + gap);
    const bh = (b / max) * chartH;
    const by = base - bh;
    bars +=
      `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, bh).toFixed(1)}" rx="3" fill="${C.blue}"/>` +
      (b > 0 ? text(bx + barW / 2, by - 4, String(b), { size: 11, fill: C.strong, weight: 600, anchor: "middle" }) : "") +
      text(bx + barW / 2, base + 15, labels[i] ?? "", { size: 10, fill: C.mut, anchor: "middle" });
  });

  const baseline = `<line x1="${PAD}" y1="${base}" x2="${PAD + CONTENT_W}" y2="${base}" stroke="${C.hair}"/>`;
  const cap = text(PAD + CONTENT_W, y, "lines changed per commit", { size: 10, fill: C.dim, anchor: "end" });

  return { svg: sectionLabel(PAD, y, "Commit sizes") + cap + baseline + bars, height: base + 20 - y };
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

function header(stats: ContributionStats): { svg: string; height: number } {
  const range =
    stats.firstDate && stats.lastDate
      ? `${shortDate(stats.firstDate)} → ${shortDate(stats.lastDate)}`
      : "";
  const svg =
    text(PAD, PAD + 12, stats.repoLabel, { size: 12, fill: C.mut, font: MONO }) +
    text(PAD, PAD + 40, `Contributions by ${stats.user}`, { size: 21, weight: 700 }) +
    text(PAD + CONTENT_W, PAD + 12, range, { size: 12, fill: C.mut, anchor: "end" });
  return { svg, height: 40 };
}

export interface RenderOptions {
  /** Cap the file list; undefined shows every changed file. */
  maxFiles?: number;
}

export function renderSVG(stats: ContributionStats, opts: RenderOptions = {}): string {
  const h = header(stats);
  let y = PAD + 40;

  if (stats.commitCount === 0) {
    const body =
      h.svg +
      text(
        PAD,
        y + 30,
        `No contributions found for ${stats.user} in ${stats.from}..${stats.to}.`,
        { size: 14, fill: C.mut },
      );
    return svgDoc(y + 54, body);
  }

  y += 24;
  const t = tiles(y, stats);
  y += 76 + 32;

  const range = rangeSection(y, stats);
  if (range.height) y += range.height + 26;

  const chartHead = sectionLabel(PAD, y, "Commits over time");
  y += 12;
  const chart = commitsChart(y, stats);
  y += chart.height + 24;

  const calendar = calendarSection(y, stats);
  if (calendar.height) y += calendar.height + 28;

  const punchcard = punchcardSection(y, stats);
  if (punchcard.height) y += punchcard.height + 28;

  const graph = graphSection(y, stats);
  if (graph.height) y += graph.height + 28;

  const diff = diffBar(y, stats);
  y += diff.height + 28;

  const sizes = commitSizeSection(y, stats);
  if (sizes.height) y += sizes.height + 30;

  const lang = languages(y, stats);
  y += lang.height + 30;

  const dirs = dirsSection(y, stats);
  if (dirs.height) y += dirs.height + 30;

  const files = filesSection(y, stats, opts.maxFiles);
  y += files.height;

  const body = [
    h.svg,
    t,
    range.svg,
    chartHead,
    chart.svg,
    calendar.svg,
    punchcard.svg,
    graph.svg,
    diff.svg,
    sizes.svg,
    lang.svg,
    dirs.svg,
    files.svg,
  ].join("\n");
  return svgDoc(y + PAD, body);
}

function svgDoc(height: number, body: string): string {
  const hh = Math.ceil(height);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${hh}" viewBox="0 0 ${W} ${hh}" role="img" font-family="${FONT}">
  <rect x="0.5" y="0.5" width="${W - 1}" height="${hh - 1}" rx="16" fill="${C.bg}" stroke="${C.panelBorder}"/>
  ${body}
</svg>`;
}
