'use strict';

// Run in the portal image. A randomly named database is created and removed;
// this script never connects to the live `db` database or live Rabbit queues.
const assert = require('assert');
const path = require('path');
const http = require('http');
const { Readable } = require('stream');
const portal = path.resolve(__dirname, '../services/portal');
const jd = path.resolve(__dirname, '../services/jd');
const dependency = name => require(path.join(portal, 'node_modules', name));
dependency('module-alias').addAlias('@', path.join(portal, '.dist'));
const mongoose = dependency('mongoose');
const yaml = dependency('js-yaml');
const fs = require('fs');
mongoose.Promise = Promise;
const database = `makyek_test_${Date.now()}_${process.pid}`;
assert(/^makyek_test_\d+_\d+$/.test(database));
const config = yaml.safeLoad(fs.readFileSync(path.join(portal, 'config.yaml'), 'utf8')).base;
const logs = [], sent = [], users = [], submissions = [];
const logger = { debug() {}, info() {}, warn() {}, error: (...args) => logs.push(args) };
global.__codeRoot = path.join(portal, '.dist');
global.DI = { config, logger };
DI.eventBus = require(path.join(portal, '.dist/services/eventBus')).default();
let failPublish = false, dispatcher, testBroker, testConnection, testVhost;
DI.mq = { publish: async (topic, payload) => {
  if (failPublish) throw new Error('Injected broker outage');
  if (topic === 'judge') {
    const match = await DI.models.Match.findById(payload.mdocid);
    const submission = await DI.models.Submission.findById(match.u1Submission);
    assert(submission.matchesReady, 'round published before matchesReady');
    assert(submission.matches.some(d => d._id.equals(match._id)), 'round published before matches[] commit');
  }
  sent.push({ topic, payload });
} };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const settled = promises => Promise.all(promises.map(p => p.then(value => ({ value }), error => ({ error }))));
const fulfilled = results => results.filter(r => !r.error);
async function rejected(promise) { await assert.rejects(promise, err => err.status === 409); }
async function newUser(name) {
  const user = await DI.models.User.createUserAsync(name, 'test-password', name, name);
  users.push(user._id); return user;
}
async function submit(user, code = 'int main(void){return 0;}', compiler = 'gcc51c11') {
  const doc = await DI.models.Submission.createSubmissionAsync(user._id, code, compiler);
  submissions.push(doc._id); return doc;
}
async function completeCompile(doc, runToken = `owner-${doc._id}`) {
  await DI.models.Submission.judgeStartCompileAsync(doc._id, doc.taskToken, runToken);
  const file = await DI.gridfs.putBlobAsync(Readable.from([Buffer.from('test executable')]), {
    metadata: { type: 'submission.binary', submission: String(doc._id) },
  });
  return DI.models.Submission.judgeCompleteCompileAsync(doc._id, doc.taskToken, true, '', file._id, runToken);
}
async function finishMatches(sid) {
  const doc = await DI.models.Submission.findById(sid);
  for (const reference of doc.matches) {
    const match = await DI.models.Match.findById(reference._id);
    await Promise.all(match.rounds.map(async (round, index) => {
      const owner = `round-${round._id}`;
      await DI.models.Match.judgeStartRoundAsync(match._id, round._id, owner);
      await DI.models.Match.judgeCompleteRoundAsync(match._id, round._id, 'u1win', { usedTime: (index + 1) * 100 }, owner);
    }));
  }
  await DI.models.Submission.reconcileMatchesAsync(sid);
}

async function tests() {
  await mongoose.connect(`mongodb://root:local-mongo-root@mongo:27017/${database}?authSource=admin`, { useMongoClient: true });
  DI.mongodbConnection = mongoose.connection;
  DI.redis = await require(path.join(portal, '.dist/services/redis')).default(logger);
  DI.gridfs = await require(path.join(portal, '.dist/services/mongodb.gridfs')).default(mongoose.connection);
  DI.models = await require(path.join(portal, '.dist/services/models')).default();
  for (const model of Object.values(DI.models)) {
    if (model.ensureIndexes) await new Promise((resolve, reject) => model.ensureIndexes(err => err ? reject(err) : resolve()));
  }
  dispatcher = require(path.join(portal, '.dist/services/task.dispatcher')).default(DI.models, logger);
  dispatcher.shutdown();
  const { User, Submission, Match, Task, Scoreboard, LeaderPair } = DI.models;
  const one = await newUser('concurrency-one');
  const results = await settled(Array.from({ length: 32 }, () => submit(one)));
  assert.equal(fulfilled(results).length, 1);
  assert.equal(await Submission.count({ user: one._id }), 1);
  const first = fulfilled(results)[0].value;
  await assert.rejects(new Submission({ user: one._id, status: 'pending', active: true }).save(), err => err.code === 11000);
  assert.equal((await User.findById(one._id)).submissionNumber, 1);
  console.log('PASS: 32 parallel submissions => exactly one accepted, backed by unique DB constraint');

  await Task.remove({ topic: 'compile' });
  failPublish = true;
  await dispatcher.tick();
  let task = await Task.findOne({ topic: 'compile' });
  assert(task && task.lastError && !task.completedAt);
  failPublish = false;
  await Task.update({ _id: task._id }, { $set: { nextAttemptAt: new Date(0) } });
  await dispatcher.tick();
  assert.equal(sent.filter(t => t.topic === 'compile').length, 1);
  console.log('PASS: missing outbox and broker outage recover without dropping submission');

  const claims = await settled(Array.from({ length: 32 }, (_, i) =>
    Submission.judgeStartCompileAsync(first._id, first.taskToken, `compile-${i}`)));
  assert.equal(fulfilled(claims).length, 1);
  let claimed = await Submission.findById(first._id);
  const oldOwner = claimed.compileRunToken;
  await Submission.judgeStartCompileAsync(first._id, first.taskToken, oldOwner); // lost response retry
  await Submission.update({ _id: first._id }, { $set: { compileLeaseUntil: new Date(0) } });
  const recovered = await completeCompile(first, 'replacement-owner');
  await rejected(Submission.judgeSetSystemErrorAsync(first._id, first.taskToken, 'late error', oldOwner));
  assert.equal(recovered.taskToken, null);
  await Promise.all(Array.from({ length: 8 }, () => Submission.prepareMatchesAsync(first._id)));
  assert.equal((await Submission.findById(first._id)).status, 'effective');
  await rejected(Submission.judgeStartCompileAsync(first._id, first.taskToken, 'late-duplicate'));
  console.log('PASS: atomic compiler claims, lease recovery and stale callback rejection');

  const two = await newUser('concurrency-two');
  const second = await submit(two);
  await completeCompile(second);
  await Promise.all(Array.from({ length: 8 }, () => Submission.prepareMatchesAsync(second._id)));
  let matches = await Match.find({ u1Submission: second._id });
  assert.equal(matches.length, 1);
  assert.equal((await Submission.findById(second._id)).matches.length, 1);
  await Task.remove({ topic: 'judge' }); // crash after references saved, before enqueue
  await dispatcher.tick();
  assert.equal(await Task.count({ topic: 'judge' }), 2);
  assert.equal(sent.filter(t => t.topic === 'judge').length, 2);
  const match = matches[0];
  const owners = [];
  for (const round of match.rounds) {
    const claimsForRound = await settled(Array.from({ length: 16 }, (_, i) =>
      Match.judgeStartRoundAsync(match._id, round._id, `claim-${round._id}-${i}`)));
    assert.equal(fulfilled(claimsForRound).length, 1);
    owners.push(fulfilled(claimsForRound)[0].value.rounds.id(round._id).runToken);
  }
  await Match.update({ _id: match._id, 'rounds._id': match.rounds[0]._id }, { $set: { 'rounds.$.leaseUntil': new Date(0) } });
  const roundOldOwner = owners[0];
  owners[0] = 'replacement-round-owner';
  await Match.judgeStartRoundAsync(match._id, match.rounds[0]._id, owners[0]);
  await rejected(Match.judgeCompleteRoundAsync(match._id, match.rounds[0]._id, 'u2win', {}, roundOldOwner));
  await Promise.all(match.rounds.map((round, i) => Match.judgeCompleteRoundAsync(
    match._id, round._id, 'u1win', { usedTime: (i + 1) * 100 }, owners[i])));
  const completed = await Match.findById(match._id);
  assert.equal(completed.status, 'u1win');
  assert.equal(completed.usedTime, 300);
  await Submission.reconcileMatchesAsync(second._id);
  const effective = await Submission.findById(second._id);
  assert.equal(effective.status, 'effective');
  await Promise.all(Array.from({ length: 10 }, () => Submission.chargeQuotaAsync(effective.toObject())));
  assert.equal(await Submission.getUsedSubmissionQuotaAsync(two._id), 300);
  await Match.judgeCompleteRoundAsync(match._id, match.rounds[0]._id, 'u1win', { usedTime: 999 }, owners[0]);
  assert.equal((await Match.findById(match._id)).usedTime, 300);
  console.log('PASS: idempotent match creation, saved-reference ordering, parallel results and quota accounting');

  await Scoreboard.flushCache();
  const [rows] = await Scoreboard.calculate();
  assert.equal(rows.find(row => row.udoc._id.equals(two._id)).score, 3);
  assert.equal(rows.find(row => row.udoc._id.equals(one._id)).lose, 1);
  const oldGetStats = LeaderPair.getStatsAsync;
  let refreshCalls = 0;
  LeaderPair.getStatsAsync = async () => { refreshCalls++; await delay(20); return oldGetStats.call(LeaderPair); };
  await DI.eventBus.emitAsyncWithProfiling('submission.status:updated::**', effective.toObject());
  await Promise.all(Array.from({ length: 20 }, () => Scoreboard.flushCache()));
  assert.equal(refreshCalls, 1);
  await DI.eventBus.emitAsyncWithProfiling('submission.status:updated::**', effective.toObject());
  const refreshing = Scoreboard.flushCache();
  await delay(5);
  await DI.eventBus.emitAsyncWithProfiling('submission.status:updated::**', effective.toObject());
  await refreshing;
  await Scoreboard.flushCache();
  assert.equal(refreshCalls, 3, 'dirty notification during refresh must not be lost');
  LeaderPair.getStatsAsync = oldGetStats;
  console.log('PASS: scoreboard aggregation, cached HTTP reads and non-overlapping refresh');

  const recompiled = await Submission.recompileAsync(second._id);
  assert(recompiled.taskToken && recompiled.taskToken !== second.taskToken);
  await rejected(Match.judgeStartRoundAsync(match._id, match.rounds[0]._id, 'obsolete-generation'));
  await rejected(Submission.checkCompileOwnerAsync(second._id, second.taskToken, `owner-${second._id}`));
  await completeCompile(recompiled);
  await Submission.prepareMatchesAsync(second._id);
  assert.equal(await Match.count({ u1Submission: second._id }), 2, 'old generation must be preserved');
  await finishMatches(second._id);
  console.log('PASS: recompilation preserves old data and fences obsolete match tasks');

  const three = await newUser('concurrency-three'), four = await newUser('concurrency-four');
  const earlier = await submit(three), later = await submit(four);
  await completeCompile(later);
  await Submission.prepareMatchesAsync(later._id);
  assert.equal((await Submission.findById(later._id)).matchesReady, false);
  await completeCompile(earlier);
  await Submission.prepareMatchesAsync(earlier._id);
  await finishMatches(earlier._id);
  await Submission.prepareMatchesAsync(later._id);
  assert((await Match.find({ u1Submission: later._id })).some(d => d.u2Submission.equals(earlier._id)));
  const notify = Match.notifyStatusAsync;
  Match.notifyStatusAsync = async () => {}; // process died before completion notifications
  await finishMatches(later._id);
  Match.notifyStatusAsync = notify;
  // Simulate a missed per-match status notification and stale embedded reference.
  const laterDoc = await Submission.findById(later._id);
  await Submission.update({ _id: later._id }, { $set: {
    status: 'running', 'matches.0.status': 'running',
  } });
  await dispatcher.tick();
  assert.equal((await Submission.findById(later._id)).status, 'effective');
  assert.equal((await Submission.findById(later._id)).matches.length, laterDoc.matches.length);
  console.log('PASS: out-of-order compiler completion and missed notifications reconcile correctly');

  const workerUtils = require(path.join(jd, '.dist/libs/utils')).default;
  let ack = 0, nack = 0;
  const mq = { ack: () => ack++, nack: (msg, all, requeue) => { assert.equal(requeue, true); nack++; } };
  await workerUtils.settleTask(Promise.reject(new Error('Injected callback outage')), mq, {}, logger);
  await delay(2100);
  assert.equal(ack, 0); assert.equal(nack, 1);
  await workerUtils.settleTask(Promise.resolve(), mq, {}, logger);
  assert.equal(ack, 1);
  console.log('PASS: failed callbacks are requeued, not acknowledged');

  const api = require(path.join(jd, '.dist/libs/api')).default;
  let attempts = 0, mode = 'retry';
  const server = http.createServer((req, res) => {
    req.resume(); attempts++;
    if (mode === 'timeout') return;
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = mode === 'retry' && attempts < 3 ? 503 : mode === 'forbidden' ? 403 : 200;
    res.end(JSON.stringify(res.statusCode === 200 ? { ok: true } : null));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previousAPI = config.api;
  config.api = { url: `http://127.0.0.1:${server.address().port}`, timeout: 100,
    credential: previousAPI.credential };
  try {
    assert((await api.compileBegin('id', 'task', 'run')).ok);
    assert.equal(attempts, 3);
    attempts = 0; mode = 'forbidden';
    await assert.rejects(api.compileBegin('id', 'task', 'run'), err => err.statusCode === 403);
    assert.equal(attempts, 1);
    attempts = 0; mode = 'timeout';
    await assert.rejects(api.compileBegin('id', 'task', 'run'), err => err instanceof api.APIRequestError);
    assert.equal(attempts, 3);
  } finally { config.api = previousAPI; await new Promise(resolve => server.close(resolve)); }
  console.log('PASS: API 5xx retry, non-retryable 4xx and bounded request timeouts');
  await endToEnd();
  console.log(`All concurrency regressions passed (${database}).`);
}

async function endToEnd() {
  // Real HTTP handlers, real RabbitMQ confirms/deliveries and real workers,
  // all isolated from the live DB and the live RabbitMQ vhost.
  const express = dependency('express');
  const app = express(), router = express.Router();
  require(path.join(portal, '.dist/services/web.common')).default(app);
  app.use(router);
  for (const name of ['submission', 'match']) {
    const Handler = require(path.join(portal, `.dist/handlers/${name}`)).default;
    new Handler(app).register(router);
  }
  app.use((err, req, res, next) => res.status(err.status || 500).json({
    err: true, name: err.name, msg: err.message,
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const workerConfig = yaml.safeLoad(fs.readFileSync(path.join(jd, 'config.yaml'), 'utf8')).base;
  config.api.url = `http://127.0.0.1:${server.address().port}`;
  config.sandbox = null;
  config.runtimeDirectory = '/workspace/runtime';
  config.compile = { ...workerConfig.compile, ...config.compile };
  config.match = { ...workerConfig.match, ...config.match };
  config.match.args = '/workspace/services/judge/.dist/bootstrap.js --config config.json';
  require(path.join(jd, 'node_modules/app-module-path')).addPath(path.join(jd, '.dist'));
  const yargs = require(path.join(jd, 'node_modules/yargs'));
  const previousMQConfig = config.mq, previousMQ = DI.mq;
  testVhost = database;
  await rabbitAdmin('PUT', `/vhosts/${testVhost}`, {});
  await rabbitAdmin('PUT', `/permissions/${testVhost}/root`, { configure: '.*', write: '.*', read: '.*' });
  config.mq = { vhosts: { [testVhost]: JSON.parse(JSON.stringify(previousMQConfig.vhosts['/'])) } };
  testBroker = await require(path.join(portal, '.dist/services/mq')).default(logger);
  DI.mq = testBroker;
  testConnection = await require(path.join(jd, 'node_modules/amqplib')).connect({
    hostname: 'rabbit', username: 'root', password: 'local-rabbit', vhost: testVhost,
  });
  const compileChannel = await testConnection.createChannel(), judgeChannel = await testConnection.createChannel();
  yargs.parse(['--role', 'compile']);
  await require(path.join(jd, '.dist/services/compile')).default(compileChannel, logger);
  yargs.parse(['--role', 'match']);
  await require(path.join(jd, '.dist/services/match')).default(judgeChannel, logger);
  try {
    await DI.models.Submission.update({}, { $set: { status: 'ce' } }, { multi: true }); // retire fake-binary fixtures
    const source = fs.readFileSync('/workspace/examples/gomoku-client.c', 'utf8');
    const cUser = await newUser('e2e-c'), cppUser = await newUser('e2e-cpp');
    const cDoc = await submit(cUser, source, 'gcc51c11');
    const cppDoc = await submit(cppUser, '#include <iostream>\n' + source, 'gpp10cpp17');
    await dispatcher.tick(); // real C/C++ compiler and GridFS upload
    await waitFor(async () => (await DI.models.Submission.findById(cDoc._id)).status === 'running' &&
      (await DI.models.Submission.findById(cppDoc._id)).status === 'running');
    await dispatcher.tick(); // ready references -> two real judge processes -> result API
    await waitFor(async () => (await DI.models.Submission.findById(cppDoc._id)).status === 'effective');
    assert.equal((await DI.models.Submission.findById(cDoc._id)).status, 'effective');
    assert.equal((await DI.models.Submission.findById(cppDoc._id)).status, 'effective');
    const match = await DI.models.Match.findOne({ u1Submission: cppDoc._id });
    assert(match && DI.models.Match.isEffectiveStatus(match.status));
    assert(match.rounds.every(r => r.logBlob && JSON.parse(r.summary).currentBoard));
    // A duplicate completion must not upload another GridFS file.
    const api = require(path.join(jd, '.dist/libs/api')).default;
    const fileCount = await mongoose.connection.collection('fs.files').count({});
    const compiled = await DI.models.Submission.findById(cppDoc._id);
    await api.compileEnd(cppDoc._id, cppDoc.taskToken, '', true, Buffer.from('duplicate'), compiled.completedCompileRunToken);
    assert.equal(await mongoose.connection.collection('fs.files').count({}), fileCount);
    console.log('PASS: real RabbitMQ confirms -> C11/C++17 -> binary API -> judge rounds -> logs -> effective');
  } finally {
    DI.mq = previousMQ; config.mq = previousMQConfig;
    await closeRabbitTest();
    await new Promise(resolve => server.close(resolve));
  }
}

async function waitFor(predicate) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(50); }
  throw new Error('End-to-end state transition timed out');
}
async function rabbitAdmin(method, endpoint, body) {
  return dependency('request-promise-native')({ method,
    url: `http://rabbit:15672/api${endpoint}`, json: true, body, timeout: 10000,
    auth: { user: 'root', pass: 'local-rabbit' },
  });
}
async function closeRabbitTest() {
  if (testConnection) { await testConnection.close(); testConnection = null; }
  if (testBroker) { await new Promise(resolve => testBroker.shutdown(resolve)); testBroker = null; }
  if (testVhost) {
    assert.equal(testVhost, database);
    await rabbitAdmin('DELETE', `/vhosts/${testVhost}`).catch(err => { if (err.statusCode !== 404) throw err; });
    testVhost = null;
    console.log('Isolated RabbitMQ test vhost removed.');
  }
}

tests().then(() => cleanup(0), err => {
  console.error(err.stack);
  logs.slice(-10).forEach(entry => console.error(...entry));
  return cleanup(1);
});
async function cleanup(code) {
  try {
    if (dispatcher) dispatcher.shutdown();
    await closeRabbitTest();
    if (DI.models && DI.models.Scoreboard) DI.models.Scoreboard.shutdown();
    if (DI.redis) {
      const keys = users.map(id => `used_quota:${id}`).concat(submissions.map(id => `charged_quota:${id}`));
      if (keys.length) await DI.redis.delAsync(keys);
      DI.redis.quit();
    }
    if (mongoose.connection.readyState === 1) {
      assert.equal(mongoose.connection.name, database);
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
      console.log('Isolated test database and test quota keys removed.');
    }
  } catch (err) { console.error('Test cleanup failed:', err.stack); code = 1; }
  process.exit(code);
}
