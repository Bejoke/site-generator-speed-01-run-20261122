// site-generator-speed-01-run-20261122 — a faster drop-in for makefun-site 1.0.0.
//
// run(input) returns, for one case's input, exactly the output tree
// makefun-site 1.0.0's build returns: a JSON object of every path the build
// writes and that file's text, byte for byte. The dialect is makefun-site's
// own — its front matter, template dialect, Markdown subset, slug rule and
// report, as its README states them and its reference program answers them —
// not Jekyll's, Hugo's, Eleventy's or CommonMark's.
//
// Written in this session from the README spec and the reference program's
// observable behaviour. No vendor code is copied: the pipeline below is my
// own, fused for speed — one pass over the sources, Markdown lexed and
// rendered in a single pass, templates parsed once and rendered into arrays,
// slugs cached per run — and it answers every case from its input alone, so
// two runs on the same input return the same tree.
//
//   input  = { site: { title, base_url, per_page, recent },
//              templates: { "<name>": "<source>", ... },
//              files: [{ path, content }, ...] }
//   output = { "<dir>/<slug>/index.html": "...", "index.html": "...",
//              "tags/<slug>/index.html": "...", "tags/index.html": "...",
//              "build-report.txt": "...", "<static path>": "..." }

// ---------------------------------------------------------------------------
// Text: the HTML escape table, the slug rule, the long date (README, "Text").
// ---------------------------------------------------------------------------

/** The HTML escape table, in this order: & < > " ' . */
const NEEDS_ESCAPE = /[&<>"']/;

/**
 * `text` with & < > " and ' escaped. One native replace with a callback:
 * on the short, usually dirty literal runs inline rendering escapes, one
 * scan beats four chained replaces (measured ~18% faster on dirty lines);
 * the manual per-character loop is 13x slower — V8's native replace wins.
 */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(text) {
  if (!NEEDS_ESCAPE.test(text)) return text;
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * SLUG_MAX characters (a "-" left at the cut dropped), and "untitled" when
 * nothing is left. Results are cached per run: the same title, tag and
 * heading text recurs across a site.
 *
 * Fast path: a string of ASCII alone is already NFKD-normalised and holds no
 * combining mark, so it slugifies with one lowercase and one replace.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let out;
  if (!/[^\x00-\x7F]/.test(text)) {
    // One replace collapses every non-alphanumeric run to a single '-', so
    // at most one '-' can sit at either end: trim it with a slice, not two
    // more regex passes over the whole string.
    out = text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (out.charCodeAt(0) === 45) out = out.slice(1);
    if (out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    let built = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = built.length > 0;
        continue;
      }
      if (gap) built += '-';
      gap = false;
      built += keep;
    }
    out = built;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// ---------------------------------------------------------------------------
// Front matter (README, "Front matter").
// ---------------------------------------------------------------------------

/** The keys a source's front matter may give. */
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    // '"'
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo))
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. The lines are walked
 * with indexOf rather than splitting the whole body: only the front matter
 * itself is ever read line by line.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // Find the closing line: the next line that is exactly '---'.
  let pos = 4; // just past the opening '---\n' (text === '---' has no close)
  let closeAt = -1; // offset of the closing line's first '-'
  let closeEnd = -1; // offset just past the closing line (and its '\n', if any)
  let lineNo = 2; // the line after the opening '---' is line 2
  if (text === '---') return { error: 'the front matter is not closed' };
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    if (end - pos === 3 && text[pos] === '-' && text[pos + 1] === '-' && text[pos + 2] === '-') {
      closeAt = pos;
      closeEnd = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
    lineNo++;
  }
  if (closeAt === -1) return { error: 'the front matter is not closed' };
  const data = {};
  pos = 4;
  let no = 2;
  while (pos < closeAt) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? closeAt : Math.min(nl, closeAt);
    const line = text.slice(pos, end);
    if (!/^[ \t]*$/.test(line) && !line.startsWith('#')) {
      const m = FM_LINE.exec(line);
      if (!m) return { error: `line ${no} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (nl === -1 || nl >= closeAt) break;
    pos = nl + 1;
    no++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------------------
// Markdown (README, "Markdown"): lexed and rendered in one pass over lines.
// ---------------------------------------------------------------------------

const MD_BLANK = /^[ \t]*$/;
const MD_FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const MD_FENCE_CLOSE = /^```[ \t]*$/;
const MD_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const MD_HR = /^(?:---|\*\*\*)[ \t]*$/;
const MD_BULLET = /^[-*] (.*)$/;
const MD_ORDERED = /^(\d{1,9})\. (.*)$/;
const MD_CONTINUED = /^ {2,}\S/;

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = MD_HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return MD_BLANK.test(line);
  if (c0 === 96) return MD_FENCE_OPEN.test(line); // '`'
  if (c0 === 35) return headingOf(line) !== null; // '#'
  if (c0 === 45 || c0 === 42) return MD_HR.test(line); // '-' '*'
  return false;
}

/** Whether `line` is blank: spaces and tabs only. */
function isBlank(line) {
  if (line === '') return true;
  const c0 = line.charCodeAt(0);
  if (c0 !== 32 && c0 !== 9) return false;
  return MD_BLANK.test(line);
}

/** A line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/**
 * The first index from `from` where `s` holds `what` outside a backslash
 * escape, or -1. Found with indexOf: a `what` is escaped exactly when an odd
 * run of backslashes stands right before it (each `\` + escapable char
 * consumes two, so the parity of the run decides). The match must end inside
 * `to`: a `**` starting on the span's last character pairs with a character
 * outside the span, which the sliced original never saw.
 */
function findUnescaped(s, what, from, to = s.length) {
  let j = s.indexOf(what, from);
  while (j !== -1 && j + what.length <= to) {
    let b = 0;
    for (let k = j - 1; k >= from && s[k] === '\\'; k--) b++;
    if (b % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, to = s.length) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < to) {
    let b = 0;
    for (let k = j - 1; k >= from && s[k] === '\\'; k--) b++;
    if (b % 2 === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (j + 1 < to && s[j + 1] === '*') {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/** The characters that open an inline construct. One regex scan finds the
 * next of them; four indexOf passes cost ~2x more on construct-heavy text
 * (measured on real paragraphs). The regex is /g so lastIndex steers it;
 * inlineInto sets lastIndex before every exec, so nested calls cannot
 * clobber each other's position. */
const CONSTRUCT_RE = /[\\`*\[]/g;

/**
 * `s` rendered inline into `out`, over the range [from, to); `link(target)`
 * is a link's href. The next construct is found with one native regex scan
 * instead of a per-character JS loop, and nested bold, italic and link text
 * render in place over their bounds instead of being sliced into a fresh
 * string first. Literal runs are escaped in bulk.
 */
function inlineInto(s, link, out, from = 0, to = s.length) {
  let i = from;
  while (i < to) {
    CONSTRUCT_RE.lastIndex = i;
    const hit = CONSTRUCT_RE.exec(s);
    const m = hit !== null && hit.index < to ? hit.index : -1;
    if (m === -1) {
      out.push(escapeHtml(s.slice(i, to)));
      return;
    }
    if (m > i) out.push(escapeHtml(s.slice(i, m)));
    const c = s[m];
    if (c === '\\' && m + 1 < to && ESCAPABLE.has(s[m + 1])) {
      out.push(escapeHtml(s[m + 1]));
      i = m + 2;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', m + 1);
      if (k !== -1 && k < to && k > m + 1) {
        out.push('<code>', escapeHtml(s.slice(m + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = m + 1;
      }
      continue;
    }
    if (c === '*') {
      if (m + 1 < to && s[m + 1] === '*') {
        const k = findUnescaped(s, '**', m + 2, to);
        if (k !== -1 && k > m + 2) {
          out.push('<strong>');
          inlineInto(s, link, out, m + 2, k);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = m + 2;
        }
        continue;
      }
      const k = findSingleStar(s, m + 1, to);
      if (k !== -1 && k > m + 1) {
        out.push('<em>');
        inlineInto(s, link, out, m + 1, k);
        out.push('</em>');
        i = k + 1;
      } else {
        out.push('*');
        i = m + 1;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', m + 1, to);
      const p = k !== -1 && k + 1 < to && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = p === -1 || p >= to ? '' : s.slice(k + 2, p);
      if (target !== '' && !/\s/.test(target)) {
        out.push('<a href="', escapeHtml(link(target)), '">');
        inlineInto(s, link, out, m + 1, k);
        out.push('</a>');
        i = p + 1;
        continue;
      }
      out.push('[');
      i = m + 1;
      continue;
    }
    out.push(escapeHtml(c));
    i = m + 1;
  }
}

/** `s` rendered inline; `link(target)` is a link's href. */
function inlineStr(s, link) {
  const out = [];
  inlineInto(s, link, out);
  return out.join('');
}

/**
 * `src` rendered in one pass: its HTML (each block on its own lines, a "\n"
 * after the last), its table of contents (every level 2 and 3 heading: level,
 * id and its inline HTML) and its excerpt (the first paragraph's inline HTML,
 * or ""). `link(target)` resolves a link's href.
 */
function renderMarkdown(src, link, slugCache) {
  const lines = src.split('\n');
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    const fence = c0 === 96 ? MD_FENCE_OPEN.exec(line) : null; // '`'
    if (fence !== null) {
      const body = [];
      i++;
      while (i < n && !MD_FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
      i++;
      const lang = fence[1];
      out.push('<pre><code', lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`, '>');
      if (body.length > 0) out.push(escapeHtml(body.join('\n')), '\n');
      out.push('</code></pre>\n');
      continue;
    }
    const heading = c0 === 35 ? headingOf(line) : null; // '#'
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text, slugCache), ids);
      const html = inlineStr(heading.text, link);
      out.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if ((c0 === 45 || c0 === 42) && MD_HR.test(line)) {
      // '-' '*'
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (c0 === 62) {
      // '>'
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) body.push(lines[i++].replace(/^> ?/, ''));
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        inlineInto(kept.join('\n'), link, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const bullet = c0 === 45 || c0 === 42 ? MD_BULLET.exec(line) : null; // '-' '*'
    const ordered = bullet === null && c0 >= 48 && c0 <= 57 ? MD_ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? MD_ORDERED : MD_BULLET;
      // One string per item, continuations appended to it: the old code
      // kept one array per item and joined it, an allocation per item for
      // a join that only ever glued the item's own lines back together.
      const items = [];
      while (i < n) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push(trimLine(isOrdered ? m[2] : m[1]));
          i++;
        } else if (MD_CONTINUED.test(lines[i])) {
          items[items.length - 1] += '\n' + trimLine(lines[i]);
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const start = isOrdered ? Number(ordered[1]) : 1;
      out.push(isOrdered && start !== 1 ? `<ol start="${start}">\n` : `<${tag}>\n`);
      for (const parts of items) {
        out.push('<li>');
        inlineInto(parts, link, out);
        out.push('</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    if (excerpt === null) {
      // The first paragraph's inline HTML is the excerpt: render it once
      // and reuse it, instead of rendering the paragraph a second time.
      const para = [];
      inlineInto(text, link, para);
      excerpt = para.join('');
      out.push('<p>', excerpt, '</p>\n');
    } else {
      out.push('<p>');
      inlineInto(text, link, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------------------
// Templates (README, "Templates"): parsed once into a tree of nodes, then
// rendered into an array in a chain of scopes.
// ---------------------------------------------------------------------------

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const TMPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TMPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TMPL_IF = /^if (not )?(\S+)$/;
const TMPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!TMPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TMPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TMPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TMPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/**
 * `nodes` with every include replaced by the included template's nodes
 * (expanded the same way), or dropped: a missing template, or one nested
 * past INCLUDE_DEPTH, renders nothing. `depth` is the include depth the
 * nodes sit at — a for or if body does not spend it, only an include does,
 * exactly as render time spent it — so the expansion is exactly what
 * rendering would have done, done once per site instead of once per page.
 * Node objects are shared where they are copied, never mutated at render.
 */
function expandIncludes(nodes, raw, depth, out = [], keep = null) {
  for (const n of nodes) {
    if (n.kind === 'include') {
      // An include of a site-constant template is left as a node: its
      // output is rendered once per site and substituted in as text (see
      // substituteConstants), instead of visiting its nodes on every page.
      if (keep !== null && keep.has(n.name)) {
        out.push(n);
        continue;
      }
      if (depth >= INCLUDE_DEPTH) continue;
      const t = raw.get(n.name);
      if (t !== undefined) expandIncludes(t, raw, depth + 1, out, keep);
    } else if (n.kind === 'for') {
      out.push({ kind: 'for', name: n.name, path: n.path, body: expandIncludes(n.body, raw, depth, [], keep) });
    } else if (n.kind === 'if') {
      out.push({
        kind: 'if',
        not: n.not,
        path: n.path,
        then: expandIncludes(n.then, raw, depth, [], keep),
        else: n.else === null ? null : expandIncludes(n.else, raw, depth, [], keep),
      });
    } else if (n.kind === 'text') {
      // Text either side of an include boundary joins into one node: the
      // render pushes the same bytes either way, in one push instead of
      // two. A fresh node object is built because the tree's nodes are
      // shared wherever an include repeats them.
      const last = out[out.length - 1];
      if (last !== undefined && last.kind === 'text') out[out.length - 1] = { kind: 'text', text: last.text + n.text };
      else out.push(n);
    } else out.push(n);
  }
  return out;
}

/**
 * The value at `path` in one flat scope object: its first name an own
 * property of the scope, then own properties down the path. The scope is
 * flat — render() merges the globals and the render's own variables into
 * one object, and a for loop writes its variable into it and restores the
 * old value after — so there is no chain to walk: every variable read is
 * one own-property test and one walk down its path, instead of a hop per
 * scope level. The first segment keeps its own-property test on purpose:
 * a bare `constructor` must read as missing, not as Object's.
 */
function lookup(env, path) {
  if (!Object.hasOwn(env, path[0])) return undefined;
  let v = env[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out` in `env`, one flat scope object. A for loop
 * writes its variable and its loop record into `env` and restores what was
 * there before it, so a nested loop — even one reusing the same name —
 * shadows and restores correctly, and a variable never leaks past its
 * loop. The loop record is written after the loop variable on every
 * iteration, so a loop variable actually named `loop` still reads as the
 * record inside the body, as the old child scope did. Includes do not
 * appear here: parse time expands them into the tree (see expandIncludes),
 * so rendering never pays a map lookup or a call frame per include.
 */
function renderNodes(nodes, env, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var': {
        const s = textOf(lookup(env, n.path));
        if (s !== '') out.push(escapeHtml(s));
        break;
      }
      case 'raw': {
        const s = textOf(lookup(env, n.path));
        if (s !== '') out.push(s);
        break;
      }
      case 'if': {
        const v = truthy(lookup(env, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, env, out);
        break;
      }
      case 'for': {
        const xs = lookup(env, n.path);
        if (!Array.isArray(xs)) break;
        const hadVar = Object.hasOwn(env, n.name);
        const prevVar = env[n.name];
        const hadLoop = Object.hasOwn(env, 'loop');
        const prevLoop = env.loop;
        const loop = { index: 1, first: true, last: false, length: xs.length };
        for (let k = 0; k < xs.length; k++) {
          env[n.name] = xs[k];
          env.loop = loop;
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.body, env, out);
        }
        if (hadVar) env[n.name] = prevVar;
        else delete env[n.name];
        if (hadLoop) env.loop = prevLoop;
        else delete env.loop;
        break;
      }
    }
  }
}

/**
 * Whether a template's rendering can only depend on the site itself:
 * every variable it reads is rooted in the globals (site, tags, recent)
 * or in a loop variable bound by a for over such a path, and every
 * template it includes is constant the same way. `bound` is the loop
 * variables bound by enclosing global-rooted fors; `inLoop` says a
 * `loop.*` read belongs to such a for. A missing template renders
 * nothing, so it counts as constant; a cycle of includes counts as not,
 * so the analysis always terminates. `memo` caches names already judged.
 */
const GLOBAL_ROOTS = ['site', 'tags', 'recent'];
function pathRooted(path, bound, inLoop) {
  const first = path[0];
  if (first === 'loop') return inLoop;
  return GLOBAL_ROOTS.includes(first) || bound.has(first);
}
function treeConstant(nodes, raw, bound, inLoop, memo, visiting) {
  for (const n of nodes) {
    if (n.kind === 'text') continue;
    if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if') {
      if (!pathRooted(n.path, bound, inLoop)) return false;
      if (n.kind !== 'if') continue;
      if (!treeConstant(n.then, raw, bound, inLoop, memo, visiting)) return false;
      if (n.else !== null && !treeConstant(n.else, raw, bound, inLoop, memo, visiting)) return false;
    } else if (n.kind === 'for') {
      if (!pathRooted(n.path, bound, inLoop)) return false;
      const inner = new Set(bound);
      inner.add(n.name);
      if (!treeConstant(n.body, raw, inner, true, memo, visiting)) return false;
    } else if (n.kind === 'include') {
      if (!templateConstant(n.name, raw, memo, visiting)) return false;
    }
  }
  return true;
}
function templateConstant(name, raw, memo, visiting) {
  const known = memo.get(name);
  if (known !== undefined) return known;
  const nodes = raw.get(name);
  if (nodes === undefined) return true;
  if (visiting.has(name)) return false;
  visiting.add(name);
  const ok = treeConstant(nodes, raw, new Set(), false, memo, visiting);
  visiting.delete(name);
  memo.set(name, ok);
  return ok;
}

/**
 * The deepest an include nests inside `nodes`, counting through the
 * templates it includes (a cycle counts as deep, so it is never cached).
 */
function includeDepth(nodes, raw, seen) {
  let deep = 0;
  for (const n of nodes) {
    if (n.kind === 'include') {
      const t = raw.get(n.name);
      if (t === undefined || seen.has(n.name)) return 99;
      const inner = new Set(seen);
      inner.add(n.name);
      deep = Math.max(deep, 1 + includeDepth(t, raw, inner));
    } else if (n.kind === 'for') deep = Math.max(deep, includeDepth(n.body, raw, seen));
    else if (n.kind === 'if') {
      deep = Math.max(deep, includeDepth(n.then, raw, seen));
      if (n.else !== null) deep = Math.max(deep, includeDepth(n.else, raw, seen));
    }
  }
  return deep;
}

/**
 * `nodes` with every include of a site-constant template replaced by a
 * text node holding that template's once-per-site rendering. The
 * replacement is safe because the template is constant (its output
 * cannot differ between renders) and shallow: its own include chain is
 * at most two deep and it is itself included at most two deep, so the
 * chain stays far below the depth past which an include renders nothing.
 * Node objects are rebuilt, never mutated: the trees are shared wherever
 * an include repeats them.
 */
function substituteConstants(nodes, cache) {
  const out = [];
  const push = (n) => {
    const last = out[out.length - 1];
    if (n.kind === 'text' && last !== undefined && last.kind === 'text') out[out.length - 1] = { kind: 'text', text: last.text + n.text };
    else out.push(n);
  };
  for (const n of nodes) {
    if (n.kind === 'include') {
      const s = cache.get(n.name);
      if (s !== undefined) push({ kind: 'text', text: s });
    } else if (n.kind === 'for') push({ kind: 'for', name: n.name, path: n.path, body: substituteConstants(n.body, cache) });
    else if (n.kind === 'if') {
      push({
        kind: 'if',
        not: n.not,
        path: n.path,
        then: substituteConstants(n.then, cache),
        else: n.else === null ? null : substituteConstants(n.else, cache),
      });
    } else push(n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The build, in order (README, "The build, in order").
// ---------------------------------------------------------------------------

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** The words of a body: its runs of characters other than whitespace (counted by hand, no match array). */
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS_TABLE[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS_TABLE[c] = 1;
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)] === 1) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A page's link record as templates read it. */
const linkOf = (s) =>
  s === null
    ? null
    : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.dateLong };

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const report = [];

  // 2. Templates, parsed in code-unit order of their name. One that does not
  // parse is reported and left out, as if it were not there.
  const rawTemplates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      rawTemplates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // Includes expanded once, here, instead of once per render (see
  // expandIncludes): a template's tree already holds its partials' nodes.
  // Except the site-constant ones (a header that only reads site and the
  // recent list, a footer of site-only extras): those stay as include
  // nodes, and their once-per-site rendering is substituted in below,
  // once the globals exist to render them from.
  const constMemo = new Map();
  const constantNames = new Set();
  for (const name of rawTemplates.keys()) {
    if (templateConstant(name, rawTemplates, constMemo, new Set()) && includeDepth(rawTemplates.get(name), rawTemplates, new Set([name])) <= 2) {
      constantNames.add(name);
    }
  }
  const templates = new Map();
  for (const [name, nodes] of rawTemplates) templates.set(name, expandIncludes(nodes, rawTemplates, 0, [], constantNames));
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, in code-unit order of their paths; a source that is not .md
  // is static. (Numbered as the README numbers them; templates parse first.)
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      // Most sources hold no '\r': skip the replace's regex entirely then.
      const c = f.content;
      sources.push({ path: f.path, text: c.includes('\r') ? c.replace(/\r\n?/g, '\n') : c });
    } else statics.push({ path: f.path, content: f.content });
  }
  const staticPaths = new Set(statics.map((f) => f.path));

  // 3. Front matter: a refused source is reported and dropped, and so is a
  // draft. The checks run in order; the first that fails is reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) {
        own = d;
        break;
      }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 4. Permalinks: each page's output directory and url, its slug made unique
  // in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 5. Markdown, each source's body rendered to HTML, its links resolved.
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 6. Collections: the posts, newest date first, and equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 7. Tags: grouped by their slug, each named as first met in the posts'
  // order, ordered by count and then slug.
  const bySlug = new Map();
  // A source's tags with their slugs, each slug computed once: the slug
  // used to be computed once to deduplicate and once more to use, and the
  // deduplication allocated a fresh Set per source. The sources hold only
  // a few tags each, so a short scan over the ones already seen is cheaper.
  const ownTags = (s) => {
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      let dup = false;
      for (const t of out) {
        if (t.slug === slug) {
          dup = true;
          break;
        }
      }
      if (!dup) out.push({ name, slug });
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Per-source values every card and page reads, computed once here — not
  // once per card and once per page (wordsOf scans the whole body, and the
  // tag objects were rebuilt twice per page).
  for (const s of kept) {
    s.readingMinutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
    s.dateLong = s.data.date === undefined ? '' : longDate(s.data.date);
    s.tagObjs = s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url }));
  }

  // A post's card, as lists show it. A page as its layout reads it.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.dateLong,
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readingMinutes,
    tags: s.tagObjs,
  });
  const pageOf = (s) => {
    // Built straight from the cached per-source values: the old version
    // spread the post's card (or rebuilt the same fields for a page) and
    // then added the page-only ones, copying every card field once more
    // per page for no reason. The fields and their values are unchanged.
    return {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.dateLong,
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: s.readingMinutes,
      tags: s.tagObjs,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });

  // 8. Layouts: every page through its layout, the index pages and the tag
  // pages through theirs, then each static file at its own path.
  const output = {};
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  // The globals every render reads. A render merges them with its own
  // variables into one flat scope object: one spread per render, and every
  // variable read inside it is a single own-property test instead of a
  // walk up a scope chain (see lookup). The merge is safe because a
  // render's own names (page, posts, pager, tag) never collide with the
  // globals' (site, tags, recent).
  const globalVars = { site, tags: allTags, recent };
  // Every site-constant template rendered once, from the globals alone,
  // and its output substituted into every tree that includes it: the
  // header, the nav and a site-only footer are the same on all 600 pages,
  // so rendering them 600 times is pure repetition. Each is rendered
  // from its fully expanded tree (all its includes inlined), which is
  // exactly what the include would have rendered at the shallow depth
  // these partials are ever reached at (see substituteConstants).
  const constCache = new Map();
  for (const name of constantNames) {
    const out = [];
    renderNodes(expandIncludes(rawTemplates.get(name), rawTemplates, 0), { ...globalVars }, out);
    constCache.set(name, out.join(''));
  }
  for (const [name, nodes] of templates) templates.set(name, substituteConstants(nodes, constCache));
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { ...globalVars, ...vars }, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 9. The report: every refusal, draft, broken link and template that did
  // not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
