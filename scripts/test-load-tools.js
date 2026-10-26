'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parse, run, client, Histogram } = require('./load-test');
const { plan } = require('./capacity-plan');
const { audit } = require('./deployment-preflight');
const { jsonLines } = require('./collect-load-metrics');
const { spawnSync } = require('child_process');

async function main() {
  assert.throws(() => parse(['--target', 'https://example.org/']));
  assert.throws(() => parse(['--scenario', 'submit']));
  assert.throws(() => parse(['--target', 'http://user:secret@localhost/']));
  assert.throws(() => parse(['--stages', '0,2']));
  assert.equal(parse(['--stages', '500']).stages[0], 500);
  const refusedSeed = spawnSync(process.execPath, [path.join(__dirname, 'seed-load-accounts.js')], {
    env: { ...process.env, MAKYEK_LOADTEST_STAGING: 'no' }, encoding: 'utf8', timeout: 3000,
  });
  assert.equal(refusedSeed.status, 1); assert.equal(refusedSeed.stdout, '');
  const hist = new Histogram(); [1, 2, 3, 180000].forEach(ms => hist.add(ms));
  assert.equal(hist.percentile(0.95), 180000, 'long judge latency must not be clipped at 60 seconds');
  assert.equal(plan().matches, 124750); assert.equal(plan().rounds, 249500);
  assert.equal(plan({ existing: true }).rounds, 499000);
  assert.equal(jsonLines('{"a":1}\n{"a":2}').length, 2);
  const services = {};
  for (const name of ['portal', 'compiler', 'judge', 'mongo', 'redis', 'rabbit']) services[name] = {};
  for (const name of ['compiler', 'judge']) Object.assign(services[name], {
    mem_limit: 1024, cpus: 2, pids_limit: 128, cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'],
  });
  assert(audit({ services }, '', '', 'staging').passed);
  const blocked = audit({ services }, '', '', 'production');
  assert(!blocked.passed);
  assert(blocked.checks.some(c => c.id === 'password-storage' && c.level === 'blocker'));
  services.portal.ports = [{ host_ip: '0.0.0.0', target: 8888 }];
  assert(!audit({ services }, '', '', 'staging').passed);
  console.log('PASS: safety gates, capacity math, long-tail histogram and redacted preflight');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'makyek-load-tools-'));
  let failing = false, redirects = false, missingBinary = false, creation = 0, polling = 0;
  let sessions = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', b => { body += b; });
    req.on('end', () => {
      if (req.url === '/slow') return;
      if (failing) { res.statusCode = 503; res.end('unavailable'); return; }
      if (req.url === '/login' && req.method === 'GET') {
        res.setHeader('Set-Cookie', `sid=private-cookie-${++sessions}; Path=/`);
        res.end('<html><input name="username"><input name="_csrf" value="private-token"></html>'); return;
      }
      if (req.url === '/login') {
        assert(req.headers.cookie.includes('private-cookie')); assert(body.includes('_csrf=private-token'));
        res.statusCode = 302; res.setHeader('Location', '/login/redirect'); res.end(); return;
      }
      if (req.url === '/submission/create' && req.method === 'GET') {
        res.end('<html><input name="_csrf" value="private-token"></html>'); return;
      }
      if (req.url === '/submission/create') {
        assert(body.includes('code=')); creation++;
        res.statusCode = 302;
        res.setHeader('Location', redirects ? 'http://example.org/stolen' : `/submission/${creation.toString(16).padStart(24, '0')}`);
        res.end(); return;
      }
      if (req.url.startsWith('/submission/')) {
        polling++;
        // Every POST must finish before the first status polling request.
        assert.equal(creation, 3);
        res.end(`<html><span class="submission-status--text ${missingBinary ? 'se' : 'effective'}">Result</span></html>`); return;
      }
      res.end('<html>Current Scoreboard<table></table></html>');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${server.address().port}/`;
  try {
    const read = await run(parse(['--target', target, '--stages', '1,2', '--duration', '0.1', '--think-ms', '0', '--max-requests', '20']));
    assert(read.passed); assert(read.stages.every(s => s.requests <= 20));
    failing = true;
    const fail = await run(parse(['--target', target, '--stages', '1,2', '--duration', '0.2', '--think-ms', '0']));
    assert(!fail.passed); assert.equal(fail.stages.length, 1); assert(fail.stages[0].aborted);
    failing = false;
    const accounts = path.join(work, 'accounts.json');
    fs.writeFileSync(accounts, JSON.stringify(Array.from({ length: 3 }, (_, i) => ({ username: `load_test_${i}`, password: 'private-password' }))));
    const submit = parse(['--target', target, '--scenario', 'submit', '--confirm-staging', '--accounts', accounts, '--concurrency', '2', '--poll-ms', '100']);
    const completed = await run(submit);
    assert(completed.passed); assert.equal(completed.submissions.effective, 3); assert.equal(polling, 3);
    assert(!JSON.stringify(completed).includes('private-'));
    redirects = true; creation = 0;
    const redirect = await run(submit);
    assert(!redirect.passed); assert(redirect.submissions.results.every(r => r.error === 'UNEXPECTED_REDIRECT_ORIGIN'));
    redirects = false; missingBinary = true; creation = 0;
    const systemError = await run(submit);
    assert(!systemError.passed); assert.equal(systemError.submissions.effective, 0);
    assert(systemError.submissions.results.every(r => r.status === 'se'));
    const excessAccounts = path.join(work, 'too-many.json');
    fs.writeFileSync(excessAccounts, JSON.stringify(Array.from({ length: 101 }, (_, i) => ({ username: `load_budget_${i}`, password: 'private-password' }))));
    await assert.rejects(run(parse(['--target', target, '--scenario', 'submit', '--confirm-staging', '--accounts', excessAccounts])), /pair estimate/);
    const timeout = client(parse(['--target', target, '--timeout-ms', '50']));
    try { await assert.rejects(timeout.request('slow'), /REQUEST_TIMEOUT/); } finally { timeout.close(); }
    console.log('PASS: bounded HTTP reads, overload stop, CSRF/cookies, burst barrier, status drain, redirect refusal and timeout');
    console.log('Load tools self-tests passed. No real application/database/server was targeted.');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(work, { recursive: true, force: true });
  }
}
main().catch(err => { console.error(err.stack); process.exitCode = 1; });
