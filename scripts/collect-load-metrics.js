'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function jsonLines(output) {
  const text = output.trim();
  if (!text) return [];
  if (text.startsWith('[')) return JSON.parse(text);
  return text.split('\n').map(line => JSON.parse(line));
}
async function main() {
  const args = process.argv.slice(2); let file = 'deploy/compose.staging.yaml', duration = 60, interval = 10;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--compose') file = args[++i];
    else if (args[i] === '--duration') duration = Number(args[++i]);
    else if (args[i] === '--interval') interval = Number(args[++i]);
    else throw new Error('Unknown option');
  }
  if (!Number.isFinite(duration) || duration < 1 || duration > 3600 || !Number.isFinite(interval) || interval < 5 || interval > 300) throw new Error('Invalid duration/interval');
  const prefix = ['compose', '-f', file];
  const docker = argv => execFileSync('docker', argv, { cwd: root, encoding: 'utf8', timeout: 20000,
    maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  let stopped = false, failed = false;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const start = Date.now();
  try {
    do {
      const sample = { at: new Date().toISOString() };
      try {
        const ids = docker([...prefix, 'ps', '-q']).trim().split(/\s+/).filter(Boolean);
        if (!ids.length || ids.some(id => !/^[a-f\d]{12,64}$/.test(id))) throw new Error('No project containers');
        sample.containers = jsonLines(docker(['stats', '--no-stream', '--format', '{{json .}}', ...ids]));
        sample.queues = jsonLines(docker([...prefix, 'exec', '-T', 'rabbit', 'rabbitmqctl', '-q', 'list_queues',
          'name', 'messages_ready', 'messages_unacknowledged', 'consumers', '--formatter', 'json']));
      } catch (err) {
        sample.error = 'Docker/queue metrics unavailable; check stack and CLI compatibility. Details omitted to avoid exposing secrets.';
        failed = true;
      }
      sample.collectionMs = Date.now() - Date.parse(sample.at);
      console.log(JSON.stringify(sample));
      if (sample.error || stopped || Date.now() - start >= duration * 1000) break;
      await delay(Math.min(interval * 1000, Math.max(0, duration * 1000 - (Date.now() - start))));
    } while (!stopped);
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  process.exitCode = failed ? 1 : 0;
}
if (require.main === module) main().catch(() => { console.error('Invalid metric collection options'); process.exitCode = 2; });
module.exports = { jsonLines };
