'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'makyek-resources-'));
const judge = path.join(root, 'services/judge/.dist/bootstrap.js');
const utils = require(path.join(root, 'services/judge/.dist/libs/utils')).default;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function compile(name, code) {
  const source = path.join(work, `${name}.c`), binary = path.join(work, name);
  fs.writeFileSync(source, code);
  const result = spawnSync('gcc', ['-O2', source, '-o', binary], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr); return binary;
}
function config(brain0, brain1) {
  const file = path.join(work, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ sandbox: null, summary: path.join(work, 'summary.json'),
    'brain0.field': 'black', 'brain0.bin': brain0, 'brain1.bin': brain1,
    'brain0.memoryLimit': 64 * 1024 * 1024, 'brain1.memoryLimit': 64 * 1024 * 1024,
    'brain0.moveTimeout': 200, 'brain1.moveTimeout': 200,
    'brain0.roundTimeout': 2000, 'brain1.roundTimeout': 2000,
    'round.size': 12, 'round.limit': 60,
  })); return file;
}
async function runLimited(binary) {
  const child = utils.spawnSandbox(binary, [], null, { maxMemory: 64 * 1024 * 1024, maxTime: 2000 });
  child.stdout.resume(); child.stderr.resume();
  const timer = setTimeout(() => utils.terminateProcess(child), 5000);
  try { return await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { clearTimeout(timer); }
}
async function main() {
  assert.equal(process.platform, 'linux', 'Run this test in the Docker test image');
  const memory = compile('memory', '#include <stdlib.h>\nint main(){void *p=malloc(200*1024*1024); return p ? 1 : 7;}');
  assert.equal(await runLimited(memory), 7);
  const fork = compile('fork', '#include <unistd.h>\nint main(){int p=fork(); if(p<0)return 7; if(p==0)_exit(0); return 1;}');
  assert.equal(await runLimited(fork), 7);
  console.log('PASS: per-program address-space limit and fork prevention');

  const normal = compile('normal', fs.readFileSync(path.join(root, 'examples/gomoku-client.c'), 'utf8'));
  const flood = compile('flood', '#include <stdio.h>\nint main(){for(;;){putchar(65);fflush(stdout);}}');
  let file = config(flood, normal);
  const result = spawnSync(process.execPath, [judge, '--config', file], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 34, result.stderr);
  assert(JSON.parse(fs.readFileSync(path.join(work, 'summary.json'), 'utf8')).exitCausedBy.includes('Output line exceeds limit'));
  console.log('PASS: newline-free output flood is bounded and judged as a loss');

  const noisySource = fs.readFileSync(path.join(root, 'examples/gomoku-client.c'), 'utf8').replace('initialize_board();',
    "initialize_board(); {char noisy[4096]; memset(noisy, 'E', sizeof(noisy)); for(int i=0;i<256;i++) fwrite(noisy,1,sizeof(noisy),stderr); fflush(stderr);}");
  const noisy = compile('noisy', noisySource);
  file = config(noisy, normal);
  const drained = spawnSync(process.execPath, [judge, '--config', file], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
  assert([33, 34, 35].includes(drained.status), drained.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(work, 'summary.json'), 'utf8')).exitCausedBy, '(normal round exit)');
  console.log('PASS: large stderr output is drained without blocking the protocol');

  const pidFile = path.join(work, 'sleep.pid');
  const sleeper = compile('sleeper', `#include <stdio.h>\n#include <unistd.h>\nint main(){FILE*f=fopen("${pidFile}","w");fprintf(f,"%d",getpid());fclose(f);for(;;)sleep(1);}`);
  file = config(sleeper, normal);
  const child = spawn(process.execPath, [judge, '--config', file]);
  child.stdout.resume(); child.stderr.resume();
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    for (let i = 0; !fs.existsSync(pidFile) && i < 100; i++) await delay(20);
    assert(fs.existsSync(pidFile), 'student process did not start');
    const studentPid = Number(fs.readFileSync(pidFile, 'utf8'));
    child.kill('SIGTERM');
    assert.equal(await closed, 36);
    await delay(200);
    assert.throws(() => process.kill(studentPid, 0), err => err.code === 'ESRCH');
    console.log('PASS: terminating judge also kills its student process group');
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
  console.log('All resource regressions passed.');
}
main().then(() => finish(0), err => { console.error(err.stack); finish(1); });
function finish(code) {
  fs.rmSync(work, { recursive: true, force: true });
  console.log('Temporary resource-test files removed.');
  process.exit(code);
}
