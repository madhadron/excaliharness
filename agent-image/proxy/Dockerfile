# The egress proxy (D-066): the agent's only way out, and the only place the
# token exists. proxy.js is the extension's dist/proxy.js.
FROM node:22-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
COPY proxy.js /opt/excaliharness/proxy.js
USER node
CMD ["node", "/opt/excaliharness/proxy.js"]
