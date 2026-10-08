import _ from 'lodash';
import glob from 'glob';

export default async () => {

  const models = glob
    .sync(`${__codeRoot}/models/*.js`)
    .map(model => require(model).default());

  // Do not accept submissions before the unique claim/idempotency indexes are
  // ready. In a brand-new database, background index creation alone has a race.
  for (const model of models) {
    if (model.ensureIndexes) await new Promise((resolve, reject) => {
      model.ensureIndexes(err => err ? reject(err) : resolve());
    });
  }
  return _.keyBy(models, 'modelName');

};
