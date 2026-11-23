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
setFlagsFromString('--no-incremental-marking');

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
const { run } = (await import('./solve.js')) as { run: (input: unknown) => unknown };

const answers: unknown[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  answers[i] = run(cases[i]!.input);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
