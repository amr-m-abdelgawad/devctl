/**
 * Runs the suite with coverage and fails if the aggregate drops.
 *
 * Bun's coverageThreshold is per-file, so a single unused helper at 40%
 * would fail CI even when All files is healthy. This script reads the
 * aggregate line instead.
 *
 *   bun run check:coverage
 */
import process from "node:process";

// Floor is the measured aggregate minus a little slack for temp plugin fixtures.
const MIN_FUNCS = 86;
const MIN_LINES = 86;

const proc = Bun.spawn(["bun", "test", "--coverage", "--coverage-reporter=text"], {
  stdout: "pipe",
  stderr: "pipe",
});
const [stdout, stderr] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
]);
const output = `${stdout}\n${stderr}`;
process.stdout.write(stdout);
process.stderr.write(stderr);

const code = await proc.exited;
if (code !== 0) {
  process.exit(code);
}

const match = output.match(/All files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|/);
if (!match) {
  process.stderr.write("check-coverage: could not parse All files coverage line\n");
  process.exit(1);
}
const funcs = Number(match[1]);
const lines = Number(match[2]);
if (funcs < MIN_FUNCS || lines < MIN_LINES) {
  process.stderr.write(
    `check-coverage: All files is ${funcs}% funcs / ${lines}% lines; need at least ${MIN_FUNCS}% / ${MIN_LINES}%\n`,
  );
  process.exit(1);
}
process.stdout.write(`check-coverage: All files ${funcs}% funcs / ${lines}% lines (min ${MIN_FUNCS}/${MIN_LINES})\n`);
