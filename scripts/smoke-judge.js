'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'makyek-judge-'));
const source = path.join(root, 'examples', 'gomoku-client.c');
const brain0 = path.join(work, 'brain0');
const brain1 = path.join(work, 'brain1');
const summary = path.join(work, 'summary.json');
const config = path.join(work, 'config.json');
const judge = path.join(root, 'services', 'judge', '.dist', 'bootstrap.js');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

const compile = run('cc', ['-O2', '-std=c11', source, '-o', brain0]);
if (compile.status !== 0) {
  process.stderr.write(compile.stderr);
  process.exit(1);
}
fs.copyFileSync(brain0, brain1);
fs.chmodSync(brain0, 0o755);
fs.chmodSync(brain1, 0o755);

fs.writeFileSync(config, JSON.stringify({
  sandbox: null,
  summary,
  'brain0.field': 'black',
  'brain0.bin': brain0,
  'brain0.moveTimeout': 2000,
  'brain0.roundTimeout': 90000,
  'brain0.memoryLimit': 367001600,
  'brain1.bin': brain1,
  'brain1.moveTimeout': 2000,
  'brain1.roundTimeout': 90000,
  'brain1.memoryLimit': 367001600,
  'round.size': 12,
  'round.limit': 60,
}));

const result = run(process.execPath, [judge, '--config', config], { cwd: work });
const normalExitCodes = new Set([33, 34, 35]);
if (!normalExitCodes.has(result.status)) {
  process.stderr.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.stderr.write(`Unexpected judge exit code: ${result.status}\n`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(summary, 'utf8'));
if (!data.currentBoard || !data.elapsedRoundTime) {
  throw new Error('Judge summary is incomplete');
}

const outcomes = {33: 'brain0 won', 34: 'brain1 won', 35: 'draw'};
console.log(`Judge smoke test passed (${outcomes[result.status]}).`);
