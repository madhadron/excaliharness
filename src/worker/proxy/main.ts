// Entry point of the egress proxy container (dist/proxy.js).
import { createProxy } from "./proxy";

const server = createProxy({ token: process.env.EXCALIHARNESS_PROXY_TOKEN ?? "" });
server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(`proxy can't listen: ${error.code ?? error.message}`);
  process.exit(1);
});
server.listen(8080, () => console.log("proxy listening on 8080"));
// As PID 1 Node gets no default SIGTERM handling; without this every
// `compose down` would wait out its timeout.
process.on("SIGTERM", () => {
  server.close();
  server.closeAllConnections();
  process.exit(0);
});
