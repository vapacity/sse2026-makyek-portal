'use strict';

// Run inside a staging portal container ONLY. Never updates/deletes existing users.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
async function seed() {
  if (process.env.MAKYEK_LOADTEST_STAGING !== 'yes') throw new Error('Staging confirmation is required');
  const prefix = process.env.MAKYEK_LOADTEST_PREFIX;
  const count = Number(process.env.MAKYEK_LOADTEST_COUNT || 10);
  if (!/^load_[a-z0-9_]{4,40}$/.test(prefix || '') || !Number.isInteger(count) || count < 1 || count > 1000) throw new Error('Invalid prefix/count');
  const portal = '/workspace/services/portal';
  const yaml = require(path.join(portal, 'node_modules/js-yaml'));
  const mongoose = require(path.join(portal, 'node_modules/mongoose'));
  const alias = require(path.join(portal, 'node_modules/module-alias'));
  alias.addAlias('@', path.join(portal, '.dist'));
  const config = yaml.safeLoad(fs.readFileSync(path.join(portal, 'config.yaml'), 'utf8')).base;
  global.DI = { config, logger: { error: () => {} } };
  const User = require(path.join(portal, '.dist/models/user')).default();
  mongoose.Promise = Promise;
  await mongoose.connect(config.db, { useMongoClient: true });
  try {
    await new Promise((resolve, reject) => User.ensureIndexes(err => err ? reject(err) : resolve()));
    if (await User.count({ userName_std: new RegExp(`^${prefix}_`) })) throw new Error('Prefix already exists: choose a new run prefix; nothing was modified');
    const accounts = [];
    for (let i = 0; i < count; i++) {
      const username = `${prefix}_${String(i + 1).padStart(4, '0')}`;
      const password = crypto.randomBytes(24).toString('hex');
      const user = await User.createUserAsync(username, password, username, username, 'student');
      user.initial = false; user.passwordNeedsReset = false; await user.save();
      accounts.push({ username, password });
    }
    // stdout is a secret fixture stream; redirect into a permission-restricted file.
    process.stdout.write(JSON.stringify(accounts, null, 2) + '\n');
  } finally { await mongoose.disconnect(); }
}
seed().catch(() => {
  console.error('Test account setup failed; do not retry the same prefix blindly. Inspect staging accounts. Connection details omitted.');
  process.exitCode = 1;
});
