import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { BadRequestError, collectStats } from "./git.js";
import { renderSVG } from "./render.js";

const app = new Hono();

const PORT = Number(process.env.PORT ?? 8787);

app.get("/healthz", (c) => c.text("ok"));

app.get("/", (c) =>
  c.text(
    [
      "gitproof",
      "",
      "GET /gitproof.svg?repo=<owner/repo|url|path>&to=<ref>&user=<name|email>[&from=<ref>]",
      "",
      "Examples:",
      "  /gitproof.svg?repo=torvalds/linux&to=HEAD&user=Linus            (whole repo)",
      "  /gitproof.svg?repo=torvalds/linux&from=v6.6&to=v6.7&user=Linus  (a range)",
      "",
      "Notes:",
      "  - `from` is optional & exclusive; omit it for the whole history (root included).",
      "  - `to` is inclusive; defaults are git `from..to` semantics.",
      "  - `user` is matched case-insensitively against author name AND email.",
      "  - `/contrib.svg` is kept as an alias of `/gitproof.svg`.",
    ].join("\n"),
  ),
);

// `/gitproof.svg` is the canonical route; `/contrib.svg` stays as an alias.
app.on("GET", ["/gitproof.svg", "/contrib.svg"], async (c) => {
  const repo = c.req.query("repo") ?? "";
  const from = c.req.query("from") ?? "";
  const to = c.req.query("to") ?? "";
  const user = c.req.query("user") ?? "";

  // `files=N` caps the file list; `files=all` or omitted shows every file.
  const filesParam = c.req.query("files");
  const maxFiles =
    filesParam && filesParam !== "all" && Number.isFinite(Number(filesParam))
      ? Math.max(1, Math.floor(Number(filesParam)))
      : undefined;

  // `others=hide` drops others' commits from the graph; default squashes them.
  const squashOthers = c.req.query("others") !== "hide";

  try {
    const stats = await collectStats({ repo, from, to, user, squashOthers });
    // Cache at the edge/browser for 15 min; contributions don't change fast.
    c.header("Content-Type", "image/svg+xml; charset=utf-8");
    c.header("Cache-Control", "public, max-age=900");
    return c.body(renderSVG(stats, { maxFiles }));
  } catch (err) {
    if (err instanceof BadRequestError) {
      c.header("Content-Type", "image/svg+xml; charset=utf-8");
      c.status(400);
      return c.body(errorSVG(err.message));
    }
    console.error("[gitproof.svg]", err);
    c.header("Content-Type", "image/svg+xml; charset=utf-8");
    c.status(500);
    return c.body(errorSVG("internal error while rendering contributions"));
  }
});

function errorSVG(message: string): string {
  const safe = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="820" height="80" viewBox="0 0 820 80" role="img">
  <rect x="0.5" y="0.5" width="819" height="79" rx="14" fill="#0d1117" stroke="#f85149"/>
  <text x="28" y="34" font-family="-apple-system, Segoe UI, sans-serif" font-size="14" font-weight="700" fill="#f85149">Could not render contributions</text>
  <text x="28" y="56" font-family="ui-monospace, Menlo, monospace" font-size="12" fill="#7d8590">${safe}</text>
</svg>`;
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`gitproof listening on http://localhost:${info.port}`);
});
