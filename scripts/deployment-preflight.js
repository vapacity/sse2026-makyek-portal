'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');

function audit(compose, portal, jd, mode = 'staging') {
  const checks = [];
  const add = (id, passed, message, productionOnly = false) => checks.push({ id,
    level: passed ? 'pass' : productionOnly && mode === 'staging' ? 'warning' : 'blocker', message });
  for (const name of ['portal', 'compiler', 'judge', 'mongo', 'redis', 'rabbit']) {
    add(`service:${name}`, !!compose.services[name], `Required service: ${name}`);
  }
  for (const [name, service] of Object.entries(compose.services || {})) {
    for (const port of service.ports || []) {
      add(`loopback:${name}:${port.target}`, ['127.0.0.1', '::1'].includes(port.host_ip), 'Published port must remain loopback-only; use an authenticated/protected proxy or SSH tunnel');
    }
    add(`privilege:${name}`, !service.privileged && service.network_mode !== 'host', 'No privileged container or host network');
    add(`docker-socket:${name}`, !(service.volumes || []).some(v => /docker\.sock/.test(v.source || '')), 'Application must not receive Docker socket access');
  }
  for (const name of ['compiler', 'judge']) {
    const service = compose.services[name] || {};
    add(`limits:${name}`, Number(service.mem_limit) > 0 && Number(service.cpus) > 0 && Number(service.pids_limit) > 0,
      'Worker needs explicit memory, CPU and process limits');
    add(`capabilities:${name}`, (service.cap_drop || []).includes('ALL') &&
      (service.security_opt || []).some(value => /^no-new-privileges(?::|=|$)/.test(value)), 'Worker must drop capabilities and prohibit privilege escalation');
  }
  const serialized = JSON.stringify(compose);
  add('demo-credentials', !/local-mongo-root|local-redis|local-rabbit|"MONGO_PASSWORD":"makyek"/.test(serialized), 'Replace demonstration infrastructure credentials and synchronize real accounts/client config', true);
  add('application-secrets', !/local-development-secret-change-me|local-judge-secret|password:\s*local-|mongodb:\/\/makyek:makyek@/.test(portal + jd), 'Replace application session/API/database demonstration secrets', true);
  add('task-isolation', false, 'Per-task sandbox and network/filesystem isolation are not implemented/verified by this checker', true);
  add('password-storage', !/this\.hash\s*=\s*plain/.test(fs.readFileSync(path.join(root, 'services/portal/src/models/user.js'), 'utf8')),
    'Local compatibility code stores passwords as plaintext; replace it with password hashing and a tested migration before production', true);
  add('supported-runtime', !/node:16\b/.test(fs.readFileSync(path.join(root, 'services/portal/Dockerfile'), 'utf8') +
    fs.readFileSync(path.join(root, 'services/jd/Dockerfile'), 'utf8')) &&
    !/mongo:4\.4\b/.test(serialized), 'Current Node 16 / MongoDB 4.4 have ended official support; an upgrade needs compatibility and migration testing', true);
  add('https-application', !/ws:\/\//.test(fs.readFileSync(path.join(root, 'services/portal/src/services/web.security.js'), 'utf8')) &&
    !/`http:\/\//.test(fs.readFileSync(path.join(root, 'services/portal/src/libs/utils.js'), 'utf8')), 'Absolute URLs, WebSocket CSP, trusted proxy and secure session cookies require end-to-end HTTPS verification', true);
  add('backup-restore', false, 'Backup/restore rehearsal, monitoring and target-server capacity acceptance need human evidence', true);
  return { mode, scope: 'Static configuration checks only; not a production safety certification',
    checks, passed: checks.every(check => check.level !== 'blocker') };
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2); let mode = 'staging', file = 'compose.yaml';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--mode') mode = args[++i];
      else if (args[i] === '--compose') file = args[++i];
      else throw new Error('Use --mode staging|production [--compose deploy/compose.staging.yaml]');
    }
    if (!['staging', 'production'].includes(mode)) throw new Error('Invalid mode');
    const compose = JSON.parse(execFileSync('docker', ['compose', '-f', file, 'config', '--format', 'json'],
      { cwd: root, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }));
    const report = audit(compose, fs.readFileSync(path.join(root, 'services/portal/config-template.yaml'), 'utf8'),
      fs.readFileSync(path.join(root, 'services/jd/config-template.yaml'), 'utf8'), mode);
    console.log(JSON.stringify(report, null, 2)); process.exitCode = report.passed ? 0 : 1;
  } catch (err) {
    // Never echo resolved Compose or subprocess stderr: they can contain secrets.
    console.error('Preflight could not inspect configuration. Check Docker Compose and required environment variables; no secrets were printed.');
    process.exitCode = 2;
  }
}
module.exports = { audit };
