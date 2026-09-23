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
    if (typeof body === 'object' && body.err === true) {
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
    resp = await promiseRetry(retry => {
      return rp({
        simple: false,
        resolveWithFullResponse: true,
        url: `${DI.config.api.url}${actionUrl}`,
        auth: {
          user: DI.config.api.credential.username,
          pass: DI.config.api.credential.password,
        },
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
        },
        ...options,
      }).catch(retry);
    }, {
      retries: 5,
    });
  } catch (err) {
    throw new APIRequestError(err.message);
  }
  if (resp.statusCode !== 200) {
    if (resp.statusCode === 500) {
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

api.compileBegin = (id, token) => {
  return requestJsonAsync('/submission/api/compileBegin', {
    method: 'POST',
    body: { id, token },
  });
};

api.compileEnd = (id, token, text, success, lzmaBuffer) => {
  const body = {
    id,
    token,
    text,
    success: String(success),
  };
  if (success && lzmaBuffer) {
    body.binary = {
      value: lzmaBuffer,
      options: {
        filename: id,
        contentType: 'application/x-xz',
      },
    };
  }
  return requestJsonAsync('/submission/api/compileEnd', {
    method: 'POST',
    formData: body,
  });
};

api.compileError = (id, token, text) => {
  return requestJsonAsync('/submission/api/compileError', {
    method: 'POST',
    body: { id, token, text },
  });
};

api.getSubmissionBinary = (id) => {
  return requestBinaryAsync('/submission/api/binary', {
    qs: { id },
    method: 'GET',
  });
};

api.roundBegin = (mid, rid) => {
  return requestJsonAsync('/match/api/roundBegin', {
    method: 'POST',
    body: { mid, rid },
  });
};

api.roundError = (mid, rid, text) => {
  return requestJsonAsync('/match/api/roundError', {
    method: 'POST',
    body: { mid, rid, text },
  });
};

api.roundComplete = (mid, rid, exitCode, summary, logBuffer) => {
  const body = {
    mid,
    rid,
    exitCode: String(exitCode),
    summary,
    log: {
      value: logBuffer,
      options: {
        filename: `${rid}_log.txt`,
        contentType: 'text/plain',
      },
    },
  };
  return requestJsonAsync('/match/api/roundComplete', {
    method: 'POST',
    formData: body,
  });
};

export default api;
