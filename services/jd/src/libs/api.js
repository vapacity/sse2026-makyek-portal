import rp from 'request-promise-native';
import promiseRetry from 'promise-retry';
import ExtendableError from 'es6-error';

const api = {};

class APIRequestError extends ExtendableError {}
class APIError extends ExtendableError {
  constructor(resp) {
    let body = resp.body;
    if (body instanceof Buffer) {
      try {
        body = JSON.parse(body.toString());
      } catch (err) {
        body = null;
      }
    }
    if (body && typeof body === 'object' && body.err === true) {
      super(`(${body.name}) ${body.msg}`);
    } else {
      super('Failed to parse API response');
    }
    this.statusCode = resp.statusCode;
  }
}
class APIServerError extends APIError {}
class APIUserError extends APIError {}

api.APIRequestError = APIRequestError;
api.APIError = APIError;
api.APIServerError = APIServerError;
api.APIUserError = APIUserError;

async function requestAsync(actionUrl, options = {}) {
  let resp;
  try {
    resp = await promiseRetry(async retry => {
      return rp({
        simple: false,
        resolveWithFullResponse: true,
        timeout: DI.config.api.timeout || 15000,
        url: `${DI.config.api.url}${actionUrl}`,
        auth: {
          user: DI.config.api.credential.username,
          pass: DI.config.api.credential.password,
        },
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
        },
        ...options,
      }).then(response => {
        if (response.statusCode >= 500 || response.statusCode === 429) retry(new APIServerError(response));
        return response;
      }).catch(retry);
    }, {
      retries: 2,
      minTimeout: 1000,
      maxTimeout: 3000,
    });
  } catch (err) {
    if (err instanceof APIError) throw err;
    throw new APIRequestError(err.message);
  }
  if (resp.statusCode !== 200) {
    if (resp.statusCode >= 500 || resp.statusCode === 429) {
      throw new APIServerError(resp);
    } else {
      throw new APIUserError(resp);
    }
  }
  return resp;
}

async function requestJsonAsync(actionUrl, options = {}) {
  const resp = await requestAsync(actionUrl, {
    json: true,
    gzip: true,
    ...options,
  });
  return resp.body;
}

async function requestBinaryAsync(actionUrl, options = {}) {
  const resp = await requestAsync(actionUrl, {
    encoding: null,
    ...options,
  });
  return resp.body;
}

api.compileBegin = (id, token, runToken) => {
  return requestJsonAsync('/submission/api/compileBegin', {
    method: 'POST',
    body: { id, token, runToken },
  });
};

api.compileEnd = (id, token, text, success, lzmaBuffer, runToken) => {
  const body = {
    id,
    token,
    runToken,
    text,
    success,
  };
  if (success && lzmaBuffer) {
    body.binary = lzmaBuffer.toString('base64');
  }
  return requestJsonAsync('/submission/api/compileEnd', {
    method: 'POST',
    body,
  });
};

api.compileError = (id, token, text, runToken) => {
  return requestJsonAsync('/submission/api/compileError', {
    method: 'POST',
    body: { id, token, text, runToken },
  });
};

api.getSubmissionBinary = (id, blob) => {
  return requestBinaryAsync('/submission/api/binary', {
    qs: { id, blob },
    method: 'GET',
  });
};

api.roundBegin = (mid, rid, runToken) => {
  return requestJsonAsync('/match/api/roundBegin', {
    method: 'POST',
    body: { mid, rid, runToken },
  });
};

api.roundError = (mid, rid, text, runToken) => {
  return requestJsonAsync('/match/api/roundError', {
    method: 'POST',
    body: { mid, rid, text, runToken },
  });
};

api.roundComplete = (mid, rid, exitCode, summary, logBuffer, runToken) => {
  const body = {
    mid,
    rid,
    runToken,
    exitCode,
    summary,
    log: Buffer.from(logBuffer || '').toString('base64'),
  };
  return requestJsonAsync('/match/api/roundComplete', {
    method: 'POST',
    body,
  });
};

export default api;
