// site-generator-speed-01-run-20261122 — driver (Node 22, standard library only).
//
// The harness runs `node /bot/main.ts` in a fresh container with no network:
//   /input/cases.json  — a JSON array of {"id", "input"}, the cases in order
//   /output/answers.json — a JSON array of the answers, one per case, same order
//
// main.ts reads every case, answers each with run() from ./solve.js, and writes the
// answers. The run is deterministic: the same cases always write the same bytes.
//
// Outside the grader's container, MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR stand in
// for /input and /output:
//   mkdir -p out && MAKEFUN_INPUT_DIR=./work/in MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// The house baseline turns V8's incremental marking off before it imports solve.js,
// and is timed with it; this entry tunes the flag the same way. It must run before
// the dynamic import below, so solve.js loads under it.
//
// --no-opt: measured ~17% faster end to end than the baseline flag alone
// (median user+sys 0.60s vs 0.72s on the practice cases, Node 24 on this VM;
// the gap held across interleaved repeats). The optimizing compiler's
// background CPU costs more than the interpreter loses on this workload —
// most of the work is native regex/replace/JSON calls, not JS arithmetic —
// and the heat counts every thread's CPU, so compiler threads are not free.
// --single-threaded removes the remaining background-thread CPU (~4% more).
// Wall time is lower too, far inside the 10s budget.
// Re-checked 24 Nov 2026 on this VM (Node 24.22.1): adding
// --max-semi-space-size=32/64 or --no-lazy showed no gain over these
// flags (e2e medians within noise, ~0.29-0.31s user+sys), so they stay
// off. The grader runs Node 22, not this VM's Node 24: the speedup
// mechanism should transfer but was not measured on Node 22.
setFlagsFromString('--no-incremental-marking --no-opt --single-threaded');

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputDir = arg('input-dir', process.env.MAKEFUN_INPUT_DIR ?? '/input');
const outputDir = arg('output-dir', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

// --input-dir may point at the cases file itself or at the directory holding it,
// mirroring the earlier entries' --input <file|dir> convention.
const casesPath = inputDir.endsWith('.json') ? inputDir : join(inputDir, 'cases.json');
let raw: string;
try {
  raw = readFileSync(casesPath, 'utf8');
} catch {
  process.stderr.write(`site-generator: no cases at ${casesPath}: pass --input-dir <dir> or set MAKEFUN_INPUT_DIR\n`);
  process.exit(2);
}

let cases: Array<{ id: string; input: unknown }>;
try {
  cases = JSON.parse(raw) as Array<{ id: string; input: unknown }>;
} catch (e) {
  process.stderr.write(`site-generator: cases.json does not parse: ${(e as Error).message}\n`);
  process.exit(2);
}
if (!Array.isArray(cases)) {
  process.stderr.write('site-generator: cases.json is not an array\n');
  process.exit(2);
}

// Dynamic import so the flag above applies before solve.js loads.
// solve.js renders each site's constant partials (a header that only
// reads the site record and the recent list, and the like) once per site
// and reuses the text on every page; the per-page work is the rest.
const { run } = (await import('./solve.js')) as { run: (input: unknown) => unknown };

const answers: unknown[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  answers[i] = run(cases[i]!.input);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
