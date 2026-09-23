FROM node:16-bullseye

WORKDIR /workspace
COPY packages/libreversi packages/libreversi

WORKDIR /workspace/services/judge
COPY services/judge/package*.json ./
RUN npm ci --legacy-peer-deps --no-audit --no-fund
COPY services/judge ./
RUN npm run build

WORKDIR /workspace/services/jd
COPY services/jd/package*.json ./
RUN npm ci --legacy-peer-deps --no-audit --no-fund
COPY services/jd ./
RUN npm run build \
  && mkdir -p /workspace/runtime /workspace/services/jd/logs \
  && chown -R node:node /workspace

USER node
CMD ["node", ".dist/jd.js", "--role", "compile"]
