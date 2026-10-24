// Throwaway: attaches to a running sign-in container's terminal without
// writing to it, forces a redraw, and prints the screen with tokens masked.
const http = require("http");
const id = process.argv[2];
const strip = (s) => s.replace(/\x1b\[(\d*)C/g, (_, n) => " ".repeat(Number(n || 1))).replace(/\x1b\[\d*G/g, " ")
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b[@-Z\\-_]/g, "").replace(/\r\n?/g, "\n");
const req = http.request({ socketPath: "/var/run/docker.sock", path: `/containers/${id}/attach?stream=1&stdout=1&stderr=1&logs=0`, method: "POST", headers: { Connection: "Upgrade", Upgrade: "tcp" } });
let out = "";
req.on("upgrade", (_r, sock, head) => {
  out += head.toString();
  sock.on("data", (d) => (out += d.toString()));
  const resize = (w) => http.request({ socketPath: "/var/run/docker.sock", path: `/containers/${id}/resize?h=50&w=${w}`, method: "POST" }).end();
  setTimeout(() => resize(999), 200);
  setTimeout(() => resize(1000), 600);
  setTimeout(() => {
    const text = strip(out).replace(/sk-ant-[A-Za-z0-9_-]+/g, "[token]").split("\n").map((l) => l.trimEnd()).filter((l) => l.trim()).filter((l) => !/^[\s░▒▓█▄*.]+$/.test(l));
    console.log(text.slice(-25).join("\n") || "(no output)");
    process.exit(0);
  }, 2500);
});
req.end();
