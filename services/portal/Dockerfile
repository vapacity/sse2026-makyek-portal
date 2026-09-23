FROM node:16-bullseye

WORKDIR /workspace
COPY packages/libreversi packages/libreversi

WORKDIR /workspace/services/portal
COPY services/portal/package*.json ./
RUN npm ci --legacy-peer-deps --no-audit --no-fund

COPY services/portal ./
COPY services/portal/config-template.yaml ./config.yaml
RUN npm run build:ui \
  && npm run build:server \
  && chown -R node:node /workspace

USER node
EXPOSE 8888
CMD ["npm", "start"]
