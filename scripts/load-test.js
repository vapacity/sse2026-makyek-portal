'use strict';

// Dependency-free, bounded closed-loop load generator. Never follows redirects
// automatically; cookies belong to one virtual user and never enter reports.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function parse(argv) {
  const options = { target: 'http://127.0.0.1:18888/', scenario: 'read', stages: [1, 5, 10],
    duration: 10, think: 100, timeout: 10000, maxRequests: 10000, p95: 1500,
    errorRate: 0.01, maxWait: 600, poll: 2000, concurrency: 5, pairBudget: 5000, compiler: 'gcc51c11' };
  const flags = { '--allow-remote': 'allowRemote', '--confirm-staging': 'staging', '--help': 'help' };
  const keys = { '--target': 'target', '--scenario': 'scenario', '--stages': 'stages',
    '--duration': 'duration', '--think-ms': 'think', '--timeout-ms': 'timeout',
    '--max-requests': 'maxRequests', '--p95-ms': 'p95', '--max-error-rate': 'errorRate',
    '--accounts': 'accounts', '--source': 'source', '--compiler': 'compiler', '--pair-budget': 'pairBudget',
    '--max-wait': 'maxWait', '--poll-ms': 'poll', '--concurrency': 'concurrency', '--report': 'report' };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (flags[key]) options[flags[key]] = true;
    else if (keys[key] && argv[i + 1] && !argv[i + 1].startsWith('--')) options[keys[key]] = argv[++i];
    else throw new Error(`Unknown or missing option: ${key}`);
  }
  if (options.help) return options;
  options.stages = String(options.stages).split(',').map(Number);
  if (!options.stages.length || options.stages.length > 10 || options.stages.some(n => !Number.isInteger(n) || n < 1 || n > 1000)) {
    throw new Error('Stages must contain 1..10 concurrency levels, each between 1 and 1000');
  }
  const bounds = { duration: [0.1, 300], think: [0, 60000], timeout: [50, 60000],
    maxRequests: [1, 100000], p95: [1, 60000], errorRate: [0, 1], maxWait: [1, 86400],
    poll: [100, 60000], concurrency: [1, 100], pairBudget: [1, 1000000] };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    options[key] = Number(options[key]);
    if (!Number.isFinite(options[key]) || options[key] < min || options[key] > max ||
      (['maxRequests', 'concurrency', 'pairBudget'].includes(key) && !Number.isInteger(options[key]))) throw new Error(`Invalid ${key}`);
  }
  const url = new URL(options.target);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Target must be an HTTP(S) base URL without credentials, query or fragment');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!local && !(options.allowRemote && options.staging)) throw new Error('Remote target requires --allow-remote --confirm-staging');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  options.target = url.href;
  if (!['read', 'submit'].includes(options.scenario)) throw new Error('Scenario must be read or submit');
  if (options.scenario === 'submit' && (!options.staging || !options.accounts)) {
    throw new Error('Submission load writes data: --confirm-staging and --accounts are required');
  }
  if (!['gcc51c11', 'gpp10cpp17'].includes(options.compiler)) throw new Error('Unknown compiler');
  return options;
}

class Histogram {
  constructor() { this.bins = new Map(); this.count = 0; this.sum = 0; this.max = 0; }
  add(ms) { const bin = Math.ceil(ms); this.bins.set(bin, (this.bins.get(bin) || 0) + 1); this.count++; this.sum += ms; this.max = Math.max(this.max, ms); }
  percentile(p) {
    if (!this.count) return null;
    let sum = 0;
    for (const bin of Array.from(this.bins.keys()).sort((a, b) => a - b)) {
      sum += this.bins.get(bin); if (sum >= Math.ceil(this.count * p)) return bin;
    }
    return null;
  }
  summary() { return { count: this.count, meanMs: this.count ? Math.round(this.sum / this.count) : null,
    p50Ms: this.percentile(0.5), p95Ms: this.percentile(0.95), p99Ms: this.percentile(0.99), maxMs: Math.ceil(this.max) }; }
}

function client(options) {
  const cookie = new Map();
  const transport = new URL(options.target).protocol === 'https:' ? https : http;
  const agent = new transport.Agent({ keepAlive: true, maxSockets: 1 });
  return {
    close: () => agent.destroy(),
    request: (route, method = 'GET', form = null) => new Promise((resolve, reject) => {
      const url = new URL(route.replace(/^\//, ''), options.target);
      const encoded = form ? new URLSearchParams(form).toString() : null;
      const started = performance.now();
      const req = transport.request(url, { method, agent, headers: {
        Cookie: Array.from(cookie, ([k, v]) => `${k}=${v}`).join('; '),
        ...(encoded ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(encoded) } : {}),
      } }, res => {
        for (const item of res.headers['set-cookie'] || []) {
          const first = item.split(';', 1)[0], equal = first.indexOf('=');
          cookie.set(first.slice(0, equal), first.slice(equal + 1));
        }
        const chunks = []; let bytes = 0;
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) req.destroy(new Error('BODY_LIMIT'));
          else chunks.push(chunk);
        });
        res.on('error', err => { clearTimeout(timer); reject(err); });
        res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode,
          location: res.headers.location, body: Buffer.concat(chunks).toString(), ms: performance.now() - started }); });
      });
      const timer = setTimeout(() => req.destroy(new Error('REQUEST_TIMEOUT')), options.timeout);
      req.on('error', err => { clearTimeout(timer); reject(err); });
      if (encoded) req.write(encoded);
      req.end();
    }),
  };
}

function csrf(body) {
  const value = body.match(/name=["']_csrf["'][^>]*value=["']([^"']+)["']/);
  if (!value) throw new Error('CSRF_FORM_MISSING');
  return value[1].replace(/&amp;/g, '&');
}
function expect(response, statuses) { if (!statuses.includes(response.status)) throw new Error(`HTTP_${response.status}`); return response; }
function redirectPath(response, options) {
  if (!response.location) throw new Error('REDIRECT_MISSING');
  const url = new URL(response.location, options.target), base = new URL(options.target);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new Error('UNEXPECTED_REDIRECT_ORIGIN');
  return url.pathname.slice(base.pathname.length);
}

async function run(options) {
  let interrupted = false;
  const stop = () => { interrupted = true; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const report = { schema: 1, startedAt: new Date().toISOString(), target: options.target,
    scenario: options.scenario, model: 'bounded closed-loop; not fixed arrival rate', stages: [], passed: false };
  try {
    if (options.scenario === 'read') {
      for (const concurrency of options.stages) {
        const start = performance.now(), deadline = start + options.duration * 1000;
        const histogram = new Histogram(), statuses = {}, errors = {};
        let issued = 0, failed = 0, abort = false;
        await Promise.all(Array.from({ length: concurrency }, async (_, vu) => {
          const user = client(options);
          try {
            while (!interrupted && !abort && performance.now() < deadline && issued < options.maxRequests) {
              const number = issued++, route = (number + vu) % 2 ? 'login' : '';
              const before = performance.now();
              try {
                const response = await user.request(route);
                statuses[response.status] = (statuses[response.status] || 0) + 1;
                expect(response, [200]);
                if (!/<html[\s>]/i.test(response.body) || (route === 'login' && !response.body.includes('name="username"')) ||
                  (route === '' && !response.body.includes('Current Scoreboard'))) {
                  throw new Error('UNEXPECTED_PAGE');
                }
              } catch (err) {
                failed++; const label = /^HTTP_\d+$|^REQUEST_TIMEOUT$|^BODY_LIMIT$|^UNEXPECTED_PAGE$/.test(err.message) ? err.message : 'NETWORK_ERROR';
                errors[label] = (errors[label] || 0) + 1;
              } finally { histogram.add(performance.now() - before); }
              if (histogram.count >= 20 && failed / histogram.count > 0.2) abort = true;
              if (options.think) await delay(options.think);
            }
          } finally { user.close(); }
        }));
        const elapsedSeconds = (performance.now() - start) / 1000, latency = histogram.summary();
        const errorRate = latency.count ? failed / latency.count : 1;
        const passed = !interrupted && !abort && latency.count > 0 && errorRate <= options.errorRate && latency.p95Ms <= options.p95;
        report.stages.push({ concurrency, elapsedSeconds, requests: latency.count, failed, statuses, errors,
          rps: latency.count / elapsedSeconds, successfulRps: (latency.count - failed) / elapsedSeconds,
          errorRate, latency, aborted: abort, passed });
        if (!passed) break; // do not increase pressure after a failed level
      }
      report.passed = report.stages.length === options.stages.length && report.stages.every(stage => stage.passed);
    } else {
      const accounts = JSON.parse(fs.readFileSync(options.accounts, 'utf8'));
      if (!Array.isArray(accounts) || accounts.length < 1 || accounts.length > 1000 ||
        accounts.some(a => !a || !/^load_[a-z0-9_]+$/.test(a.username) || typeof a.password !== 'string' || !a.password) ||
        new Set(accounts.map(a => a.username)).size !== accounts.length) throw new Error('Use 1..1000 unique load_* test accounts');
      const estimatedFreshPairs = accounts.length * (accounts.length - 1) / 2;
      if (estimatedFreshPairs > options.pairBudget) throw new Error('Fresh-cohort pair estimate exceeds --pair-budget; review capacity before raising it');
      const source = fs.readFileSync(options.source || path.join(__dirname, '../examples/gomoku-client.c'), 'utf8');
      if (Buffer.byteLength(source) > 1048576) throw new Error('Source exceeds 1 MiB');
      const results = [], sessions = [], start = performance.now(); let next = 0, authFailed = false;
      // Authenticate first, then release the submission batch. Login's built-in
      // one-second delay must not accidentally turn a burst into a trickle.
      try {
      const authResults = await Promise.all(Array.from({ length: Math.min(options.concurrency, accounts.length) }, async () => {
        while (!interrupted && !authFailed && next < accounts.length) {
          const account = accounts[next++], user = client(options);
          try {
            const login = expect(await user.request('login'), [200]);
            const signedIn = expect(await user.request('login', 'POST', { username: account.username,
              password: account.password, _csrf: csrf(login.body) }), [302, 303]);
            if (redirectPath(signedIn, options) !== 'login/redirect') throw new Error('LOGIN_REDIRECT_INVALID');
            const form = expect(await user.request('submission/create'), [200]);
            sessions.push({ user, token: csrf(form.body), result: { accepted: false, status: 'not_submitted' } });
          } catch (err) { user.close(); authFailed = true; return err; }
        }
      }));
      const authError = authResults.find(value => value instanceof Error);
      if (authError) throw authError;
      next = 0;
      const burstStart = performance.now();
      await Promise.all(Array.from({ length: Math.min(options.concurrency, accounts.length) }, async () => {
        while (!interrupted && next < sessions.length) {
          const session = sessions[next++], { user, result, token } = session;
          try {
            session.submittedAt = performance.now();
            const accepted = expect(await user.request('submission/create', 'POST', {
              code: source, compiler: options.compiler, _csrf: token,
            }), [302, 303]);
            const route = redirectPath(accepted, options);
            if (!/^submission\/[a-f\d]{24}$/.test(route)) throw new Error('SUBMISSION_REDIRECT_INVALID');
            result.accepted = true; result.id = route.split('/')[1]; result.status = 'pending'; session.route = route;
          } catch (err) {
            result.error = /^HTTP_\d+$|^[A-Z_]+$/.test(err.message) ? err.message : 'CLIENT_ERROR';
          }
        }
      }));
      const submissionWindowSeconds = (performance.now() - burstStart) / 1000;
      // Poll separately in bounded sweeps so 500 sessions do not create 500
      // simultaneous requests. maxWait is per-submission, not per HTTP poll.
      while (!interrupted) {
        const pending = sessions.filter(s => s.route && !s.result.error && !['effective', 'ce', 'se'].includes(s.result.status));
        if (!pending.length) break;
        let pollIndex = 0;
        await Promise.all(Array.from({ length: Math.min(10, pending.length) }, async () => {
          while (!interrupted && pollIndex < pending.length) {
            const session = pending[pollIndex++], { result, user } = session;
            if (performance.now() - session.submittedAt >= options.maxWait * 1000) { result.error = 'DRAIN_TIMEOUT'; continue; }
            try {
              const detail = expect(await user.request(session.route), [200]);
              const match = detail.body.match(/submission-status--text\s+(pending|compiling|ce|se|running|effective)\b/);
              if (!match) throw new Error('SUBMISSION_STATUS_MISSING');
              result.status = match[1];
              result.endToEndMs = Math.ceil(performance.now() - session.submittedAt);
              if (['ce', 'se'].includes(result.status)) result.error = 'JUDGE_FAILURE';
            } catch (err) { result.error = /^HTTP_\d+$|^[A-Z_]+$/.test(err.message) ? err.message : 'CLIENT_ERROR'; }
          }
        }));
        if (sessions.some(s => s.route && !s.result.error && !['effective', 'ce', 'se'].includes(s.result.status))) await delay(options.poll);
      }
      for (const session of sessions) {
        if (interrupted && session.result.status !== 'effective' && !session.result.error) session.result.error = 'INTERRUPTED';
        results.push(session.result);
      }
      const elapsedSeconds = (performance.now() - start) / 1000;
      const effective = results.filter(r => r.status === 'effective' && !r.error).length;
      const latency = new Histogram(); results.filter(r => r.status === 'effective').forEach(r => latency.add(r.endToEndMs));
      report.submissions = { planned: accounts.length, attempted: sessions.filter(s => Number.isFinite(s.submittedAt)).length,
        accepted: results.filter(r => r.accepted).length, effective, elapsedSeconds,
        effectivePerSecond: effective / elapsedSeconds, endToEnd: latency.summary(), results };
      report.submissions.submissionWindowSeconds = submissionWindowSeconds;
      report.submissions.freshCohortPairEstimate = estimatedFreshPairs;
      report.submissions.estimateWarning = 'Existing participants/submissions can create more pairs; this is not a hard queue budget';
      report.passed = !interrupted && effective === accounts.length;
      } finally { for (const session of sessions) session.user.close(); }
    }
    report.interrupted = interrupted;
    report.finishedAt = new Date().toISOString();
    return report;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

if (require.main === module) {
  (async () => {
    const options = parse(process.argv.slice(2));
    if (options.help) {
      console.log('Read: node scripts/load-test.js --target http://127.0.0.1:18888/ --stages 1,5,10 --duration 10 --report .loadtest/read.json');
      console.log('Write: add --scenario submit --confirm-staging --accounts .loadtest/accounts.json [--concurrency 5 --max-wait 600]');
      console.log('Remote: requires --allow-remote --confirm-staging. Run only against an authorized staging environment.');
      return;
    }
    if (options.report && fs.existsSync(options.report)) throw new Error('Report already exists; choose a new path before sending load');
    const report = await run(options);
    if (options.report) {
      fs.mkdirSync(path.dirname(options.report), { recursive: true, mode: 0o700 });
      fs.writeFileSync(options.report, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.passed ? 0 : 1;
  })().catch(err => { console.error(`Load test refused/failed: ${err.code || err.message}`); process.exitCode = 2; });
}
module.exports = { parse, run, client, Histogram, csrf, redirectPath };
