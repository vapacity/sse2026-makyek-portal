FROM makyek-mac-portal AS portal
FROM makyek-mac-compiler

# Test-only image; production workers do not need portal dependencies.
COPY --from=portal --chown=node:node /workspace/services/portal /workspace/services/portal
COPY --chown=node:node scripts /workspace/scripts
COPY --chown=node:node examples /workspace/examples
WORKDIR /workspace/services/portal
CMD ["node", "/workspace/scripts/test-concurrency.js"]
