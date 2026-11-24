/**
 * Runs the suite with coverage and fails if the aggregate drops.
 *
 * Bun's coverageThreshold is per-file, so a single unused helper at 40%
 * would fail CI even when All files is healthy. This script reads the
 * aggregate line instead.
 *
 *   bun run check:coverage
 */
import { appendFileSync } from "node:fs";
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
const output = stripAnsi(`${stdout}\n${stderr}`);
const code = await proc.exited;
const failures = output.split("\n").filter((line) => line.includes("(fail)") || line.startsWith("error:"));
const totals = output.match(/(\d+)\s+pass\s*\n(?:.*\n){0,6}?\s*(\d+)\s+fail/);
const match = output.match(/All files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|/);
const funcs = match ? Number(match[1]) : undefined;
const lines = match ? Number(match[2]) : undefined;
const coverageLow = funcs !== undefined && lines !== undefined && (funcs < MIN_FUNCS || lines < MIN_LINES);
const report = coverageReport({ code, failures, totals, funcs, lines, coverageLow });

// Print the verdict before the full log. GitHub keeps the start of a long step
// and drops the middle, which previously hid the failing test and the total.
process.stderr.write(`${report}\n`);
const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  appendFileSync(summary, `${report}\n`);
}
process.stdout.write(stdout);
process.stderr.write(stderr);

if (code !== 0 || !match || coverageLow) {
  process.exit(code === 0 ? 1 : code);
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function coverageReport(input: {
  code: number;
  failures: string[];
  totals: RegExpMatchArray | null;
  funcs: number | undefined;
  lines: number | undefined;
  coverageLow: boolean;
}): string {
  const lines: string[] = [];
  const counted = input.totals ? `${input.totals[1]} pass, ${input.totals[2]} fail` : "totals not found";
  lines.push(`check-coverage: bun test exited ${input.code} (${counted})`);
  if (input.failures.length === 0) {
    lines.push("check-coverage: no (fail) lines");
  } else {
    for (const failure of input.failures.slice(0, 30)) {
      lines.push(`::error::${failure}`);
    }
  }
  if (input.funcs === undefined || input.lines === undefined) {
    lines.push("::error::check-coverage: could not parse All files coverage line");
  } else {
    const mark = input.coverageLow ? "below" : "meets";
    lines.push(`check-coverage: All files ${input.funcs}% funcs / ${input.lines}% lines (${mark} ${MIN_FUNCS}/${MIN_LINES})`);
  }
  return lines.join("\n");
}
