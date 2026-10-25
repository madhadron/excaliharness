// Stand-in egress proxy (E-005): forwards to Claude's API only, replacing the
// Authorization header. Logs methods, paths and header names, never values.
const http = require("http");
const https = require("https");
const TOKEN = process.env.PROXY_TOKEN || "";
http.createServer((req, res) => {
  const headers = { ...req.headers, host: "api.anthropic.com", authorization: `Bearer ${TOKEN}` };
  delete headers["x-api-key"];
  console.log(`-> ${req.method} ${req.url.split("?")[0]} headers: ${Object.keys(req.headers).sort().join(",")}`);
  const up = https.request({ host: "api.anthropic.com", path: req.url, method: req.method, headers }, (r) => {
    console.log(`<- ${r.statusCode} for ${req.url.split("?")[0]}`);
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", (e) => { console.log(`upstream error ${e.code}`); res.writeHead(502).end(); });
  req.pipe(up);
}).listen(8080, () => console.log("proxy listening"));
