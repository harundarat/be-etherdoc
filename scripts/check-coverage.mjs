import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const reportPath = `${repositoryRoot}/coverage/coverage-final.json`;
const report = JSON.parse(await readFile(reportPath, 'utf8'));

const scopes = [
  {
    matches: (path) => path.includes('/src/auth/'),
    name: 'authentication',
    thresholds: { branches: 60, functions: 60, lines: 70, statements: 70 },
  },
  {
    matches: (path) => path.includes('/src/health/'),
    name: 'health',
    thresholds: { branches: 65, functions: 75, lines: 70, statements: 70 },
  },
  {
    matches: (path) => path.includes('/src/storage/'),
    name: 'storage',
    thresholds: { branches: 60, functions: 75, lines: 75, statements: 75 },
  },
  {
    matches: (path) => path.endsWith('/src/workers/outbox-worker.service.ts'),
    name: 'outbox worker',
    thresholds: { branches: 35, functions: 70, lines: 65, statements: 65 },
  },
];

function addHits(target, hits) {
  target.covered += hits.filter((count) => count > 0).length;
  target.total += hits.length;
}

function measure(entries) {
  const totals = {
    branches: { covered: 0, total: 0 },
    functions: { covered: 0, total: 0 },
    lines: { covered: 0, total: 0 },
    statements: { covered: 0, total: 0 },
  };
  for (const coverage of entries) {
    addHits(totals.statements, Object.values(coverage.s));
    addHits(totals.functions, Object.values(coverage.f));
    for (const branch of Object.values(coverage.b)) {
      addHits(totals.branches, branch);
    }
    const lines = new Map();
    for (const [statementId, hits] of Object.entries(coverage.s)) {
      const line = coverage.statementMap[statementId].start.line;
      lines.set(line, (lines.get(line) ?? 0) + hits);
    }
    addHits(totals.lines, [...lines.values()]);
  }
  return Object.fromEntries(
    Object.entries(totals).map(([metric, value]) => [
      metric,
      value.total === 0 ? 100 : (value.covered / value.total) * 100,
    ]),
  );
}

const failures = [];
for (const scope of scopes) {
  const entries = Object.entries(report)
    .filter(([path]) => scope.matches(path))
    .map(([, coverage]) => coverage);
  if (entries.length === 0) {
    failures.push(`${scope.name}: no coverage data found`);
    continue;
  }
  const measured = measure(entries);
  const summary = Object.entries(measured)
    .map(([metric, percentage]) => `${metric}=${percentage.toFixed(2)}%`)
    .join(', ');
  console.log(`Coverage ${scope.name}: ${summary}`);
  for (const [metric, threshold] of Object.entries(scope.thresholds)) {
    if (measured[metric] < threshold) {
      failures.push(
        `${scope.name} ${metric} ${measured[metric].toFixed(2)}% is below ${threshold}%`,
      );
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Critical coverage thresholds failed:\n${failures.join('\n')}`);
}
