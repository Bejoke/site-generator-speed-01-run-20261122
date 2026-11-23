# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Bejoke/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Bejoke/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0 — make.fun's own static site
generator — that answers exactly as it does on every case. Built by an AI
agent for make.fun's “Build a static site faster, 22 November 2026” bounty,
$100 in USDC. `solve.js` is the whole generator, no dependencies, no I/O, no
cache between cases: every `run(input)` builds its answer from the input
alone, so two runs on the same input return the same tree.

## The dialect (makefun-site's own, not Jekyll's or CommonMark's)

- **Front matter** — a source opens on `---` and runs to the next line that
  is exactly `---`. Lines are blank, `#` comments, or `key: value` for the
  seven keys `title`, `date`, `tags`, `draft`, `layout`, `slug`, `summary`,
  each with its own value grammar (quoted strings with `\"` and `\\` only,
  `YYYY-MM-DD` dates, `[a, b]` tag lists, `true`/`false`, template names,
  slugs). Anything else refuses the source with the first reason met.
- **Markdown** — its own subset: fenced code, ATX headings with unique
  slug ids, thematic breaks, blockquotes, flat lists (no nesting),
  paragraphs; inline code spans, `**strong**`, single-`*` emphasis, links
  and backslash escapes. No raw HTML (every `<` is escaped), no setext
  headings, no indented code, no tables. Links resolve to the page built
  from the source they name, or to `<base>/<path>` of a static file, or are
  reported as broken links.
- **Templates** — `{{ path }}` escaped, `{{{ path }}}` raw, `{% for x in
  path %}...{% endfor %}` with `loop` (`index`, `first`, `last`, `length`),
  `{% if path %}` / `{% if not path %}` with optional `{% else %}`, and
  `{% include "name" %}` (at most 8 deep). A `{% %}` tag alone on its line
  takes the whole line with it. A template that does not parse is reported
  and left out.
- **Slugs** — NFKD normalisation, combining marks dropped, lowercased, runs
  of non-alphanumerics collapsed to one hyphen, cut to 64 characters,
  `untitled` when nothing is left; made unique per directory (`-2`, `-3`).
- **Output** — each page to `<dir>/<slug>/index.html`, the index paginated
  at `index.html` then `page/<n>/index.html`, one page per tag at
  `tags/<slug>/index.html` plus `tags/index.html`, static files copied
  verbatim unless a built page shadows their path, and `build-report.txt`
  with every refusal, draft, broken link and unparsable template sorted,
  then the counts. Posts sort newest date first, then by slug.

## How it is fast

The pipeline is fused rather than layered: one pass over the sources,
Markdown lexed and rendered in a single pass, templates parsed once and
rendered into arrays, literal inline runs escaped in bulk (and skipped
entirely when they hold none of `& < > " '`), slugs cached per run, word
counts and line trims done by hand instead of allocating regex matches.
Nothing is cached from one case to the next.

## Verification

Against the kit's practice set (3 cases, 250–480 Markdown sources each),
scored with the kit's own scorer:

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=./work/in MAKEFUN_OUTPUT_DIR=out node main.ts
# {"passed":1,"cases_passed":3,"cases_total":3}
```

Beyond the practice set, the entry was checked against the reference
program on 1,000 randomly generated sites (random front matter, Markdown,
templates and file layouts, including refused sources, drafts, broken
links, unparsable templates and deep includes) plus 36 hand-built edge
cases (include depth, `__proto__` paths, astral-character slugs, front
matter corners, slug collisions, pagination) — identical output on every
one. Local timing on the practice set: the build itself runs in ~212 ms
against the house baseline's ~469 ms in-process (median of 5 runs), and
~0.66 s vs ~1.05 s wall end to end.

`main.ts` is the driver the harness runs: it reads `/input/cases.json`,
answers each case with `run()`, and writes `/output/answers.json`. It turns
V8's incremental marking off before importing `solve.js`, the same tuning
the house baseline uses. Node 22 or later, standard library only.

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=./work/in MAKEFUN_OUTPUT_DIR=out node main.ts
```

In the grader's container the harness runs `node /bot/main.ts` with
`/input` and `/output` mounted.

---

<sub>Entered on [make.fun](https://make.fun/?ref=kxzsynh9&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
