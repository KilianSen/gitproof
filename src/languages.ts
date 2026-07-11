/**
 * Minimal filename/extension → language mapping for the contribution breakdown.
 * Not exhaustive on purpose — anything unknown falls into "Other".
 */

const EXT_TO_LANG: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  rs: "Rust",
  go: "Go",
  java: "Java",
  kt: "Kotlin",
  kts: "Kotlin",
  c: "C",
  h: "C",
  cc: "C++",
  cpp: "C++",
  cxx: "C++",
  hpp: "C++",
  hh: "C++",
  cs: "C#",
  rb: "Ruby",
  php: "PHP",
  swift: "Swift",
  m: "Objective-C",
  mm: "Objective-C++",
  scala: "Scala",
  dart: "Dart",
  ex: "Elixir",
  exs: "Elixir",
  erl: "Erlang",
  hs: "Haskell",
  clj: "Clojure",
  lua: "Lua",
  pl: "Perl",
  r: "R",
  jl: "Julia",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  fish: "Shell",
  ps1: "PowerShell",
  sql: "SQL",
  html: "HTML",
  htm: "HTML",
  css: "CSS",
  scss: "SCSS",
  sass: "Sass",
  less: "Less",
  vue: "Vue",
  svelte: "Svelte",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  xml: "XML",
  md: "Markdown",
  mdx: "Markdown",
  rst: "reStructuredText",
  tex: "TeX",
  proto: "Protobuf",
  graphql: "GraphQL",
  gql: "GraphQL",
  tf: "Terraform",
  dockerfile: "Dockerfile",
  gradle: "Gradle",
  cmake: "CMake",
  make: "Makefile",
  vim: "Vim script",
  zig: "Zig",
  nim: "Nim",
  ml: "OCaml",
  fs: "F#",
};

const FILENAME_TO_LANG: Record<string, string> = {
  dockerfile: "Dockerfile",
  makefile: "Makefile",
  "cmakelists.txt": "CMake",
  "go.mod": "Go",
  "go.sum": "Go",
  "cargo.toml": "TOML",
  "cargo.lock": "TOML",
};

/** Stable-ish colors for common languages; unknowns get a neutral gray. */
export const LANGUAGE_COLORS: Record<string, string> = {
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Python: "#3572A5",
  Rust: "#dea584",
  Go: "#00ADD8",
  Java: "#b07219",
  Kotlin: "#A97BFF",
  C: "#555555",
  "C++": "#f34b7d",
  "C#": "#178600",
  Ruby: "#701516",
  PHP: "#4F5D95",
  Swift: "#F05138",
  Scala: "#c22d40",
  Dart: "#00B4AB",
  Elixir: "#6e4a7e",
  Haskell: "#5e5086",
  Lua: "#000080",
  Shell: "#89e051",
  SQL: "#e38c00",
  HTML: "#e34c26",
  CSS: "#563d7c",
  SCSS: "#c6538c",
  Vue: "#41b883",
  Svelte: "#ff3e00",
  JSON: "#cbcb41",
  YAML: "#cb171e",
  TOML: "#9c4221",
  Markdown: "#083fa1",
  TeX: "#3D6117",
  Zig: "#ec915c",
  Other: "#8b949e",
};

/**
 * Resolve the last real path out of a numstat path field, which for renames
 * looks like `old => new` or `dir/{old => new}/file`.
 */
export function normalizeRenamePath(raw: string): string {
  let p = raw.trim();
  // dir/{a => b}/file  ->  dir/b/file
  p = p.replace(/\{[^}]*=>\s*([^}]*)\}/g, (_m, to: string) => to.trim());
  // a => b  ->  b
  const arrow = p.split("=>");
  if (arrow.length === 2) p = arrow[1]!.trim();
  return p.replace(/\/{2,}/g, "/");
}

export function languageForPath(rawPath: string): string {
  const path = normalizeRenamePath(rawPath);
  const base = path.split("/").pop() ?? path;
  const lower = base.toLowerCase();

  if (FILENAME_TO_LANG[lower]) return FILENAME_TO_LANG[lower]!;
  // Dockerfile.foo / Makefile.bar style
  if (lower.startsWith("dockerfile")) return "Dockerfile";
  if (lower.startsWith("makefile")) return "Makefile";

  const dot = lower.lastIndexOf(".");
  if (dot > 0 && dot < lower.length - 1) {
    const ext = lower.slice(dot + 1);
    if (EXT_TO_LANG[ext]) return EXT_TO_LANG[ext]!;
  }
  return "Other";
}
