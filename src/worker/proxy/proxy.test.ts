import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createProxy } from "./proxy";

const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
const ok: Handler = (_req, res) => {
  res.writeHead(200, { "content-type": "application/json", "keep-alive": "timeout=99" }).end('{"ok":true}');
};

// A fake upstream that records what it received.
async function setup(token = "sk-ant-oat01-real", handler: Handler = ok) {
  const received: http.IncomingHttpHeaders[] = [];
  const bodies: string[] = [];
  const upstreamPort = await listen(
    http.createServer((req, res) => {
      received.push(req.headers);
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => bodies.push(body));
      handler(req, res);
    }),
  );
  const logs: string[] = [];
  const upstream = {
    host: "127.0.0.1",
    request: ((options: http.RequestOptions, callback: (res: http.IncomingMessage) => void) =>
      http.request({ ...options, host: "127.0.0.1", port: upstreamPort }, callback)) as unknown as typeof import("node:https").request,
  };
  const port = await listen(createProxy({ token, log: (l) => logs.push(l), upstream }));
  const send = (pathname: string, headers: Record<string, string> = {}, body = '{"model":"m","messages":[]}', method = "POST", signal?: AbortSignal) =>
    fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers, ...(method === "GET" ? {} : { body }), ...(signal ? { signal } : {}) });
  return { received, bodies, logs, send };
}

describe("egress proxy", () => {
  it("forwards /v1/ requests with the real token, dropping the agent's credentials", async () => {
    const { received, logs, send } = await setup();
    const res = await send("/v1/messages", { authorization: "Bearer placeholder", "x-api-key": "nope", "anthropic-beta": "oauth" });
    expect(res.status).toBe(200);
    expect(received[0]?.authorization).toBe("Bearer sk-ant-oat01-real");
    expect(received[0]?.["x-api-key"]).toBeUndefined();
    expect(received[0]?.["anthropic-beta"]).toBe("oauth");
    expect(res.headers.get("keep-alive")).not.toBe("timeout=99");
    expect(logs.join("\n")).not.toContain("sk-ant");
    expect(logs.join("\n")).not.toContain("placeholder");
  });

  it("forwards the query string and the body unchanged", async () => {
    const { bodies, send } = await setup();
    expect((await send("/v1/messages?beta=true")).status).toBe(200);
    expect(bodies[0]).toBe('{"model":"m","messages":[]}');
  });

  it.each(["/", "/admin", "/v1/../secret", "/v2/messages", "/v1/files", "/v1/messages/batches", "/v1/models"])("refuses %s", async (pathname) => {
    const { received, send } = await setup();
    expect((await send(pathname)).status).toBe(403);
    expect(received).toEqual([]);
  });

  it("refuses anything but POST", async () => {
    const { received, send } = await setup();
    expect((await send("/v1/messages", {}, "", "GET")).status).toBe(403);
    expect(received).toEqual([]);
  });

  it.each([
    ['{"mcp_servers":[{"url":"https://x"}]}', /MCP/],
    ['{"container":"c"}', /containers/],
    ['{"tools":[{"type":"web_fetch_20250910","name":"web_fetch"}]}', /server tools/],
    ['{"tools":[{"type":"code_execution_20250825"}]}', /server tools/],
    ["not json", /isn't JSON/],
    ["[1]", /JSON object/],
  ])("refuses the body %s (D-079)", async (body, why) => {
    const { received, send } = await setup();
    const res = await send("/v1/messages", {}, body);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.text()).toMatch(why);
    expect(received).toEqual([]);
  });

  it.each([
    [{ messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://evil.example/?d=secret" } }] }] }],
    [{ messages: [{ role: "user", content: [{ type: "tool_result", content: [{ type: "document", source: { type: "url", url: "https://x" } }] }] }] }],
    [{ messages: [{ role: "user", content: [{ type: "image", source: { type: "file", file_id: "f" } }] }] }],
    [{ system: [{ type: "text", text: "x", source: { type: "url" } }] }],
    [{ messages: [{ role: "user", content: [{ type: "document", source: { type: "content", content: [{ type: "image", source: { type: "url", url: "https://evil/?d=x" } }] } }] }] }],
  ])("refuses content fetched from elsewhere: %j", async (body) => {
    const { received, send } = await setup();
    const res = await send("/v1/messages", {}, JSON.stringify(body));
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/fetched from elsewhere/);
    expect(received).toEqual([]);
  });

  it("refuses deeply nested bodies anywhere instead of crashing", async () => {
    const { received, send } = await setup();
    const deep = `{"messages":[],"metadata":${"[".repeat(100_000)}${"]".repeat(100_000)}}`;
    const res = await send("/v1/messages", {}, deep);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/nested too deeply/);
    expect((await send("/v1/messages")).status).toBe(200);
    expect(received).toHaveLength(1);
  });

  it("quotes what the agent sent in its log, so a refusal can't forge a line", async () => {
    const { logs, send } = await setup();
    await send("/v1/messages", {}, JSON.stringify({ tools: [{ type: "x\nrefused POST /v1/files: ok" }] }));
    expect(logs.filter((l) => l.includes("\n"))).toEqual([]);
  });

  it("allows inline images and documents", async () => {
    const { send } = await setup();
    const body = { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }, { type: "document", source: { type: "text", data: "hi" } }] }] };
    expect((await send("/v1/messages", {}, JSON.stringify(body))).status).toBe(200);
  });

  it("forwards the body as checked, so duplicate keys can't be read differently upstream", async () => {
    const { bodies, send } = await setup();
    expect((await send("/v1/messages", {}, '{"model":"a","model":"b","messages":[]}')).status).toBe(200);
    expect(bodies[0]).toBe('{"model":"b","messages":[]}');
  });

  it("refuses bodies over the limit without reading them whole", async () => {
    const { received, send } = await setup();
    const res = await send("/v1/messages", {}, "x".repeat(33 * 1024 * 1024)).catch(() => undefined);
    if (res) expect(res.status).toBe(413);
    expect(received).toEqual([]);
  });

  it("allows custom tools", async () => {
    const { send } = await setup();
    const body = JSON.stringify({ tools: [{ name: "Read", input_schema: {} }, { type: "custom", name: "x", input_schema: {} }] });
    expect((await send("/v1/messages", {}, body)).status).toBe(200);
  });

  it("refuses betas for features that reach other hosts", async () => {
    const { received, send } = await setup();
    expect((await send("/v1/messages", { "anthropic-beta": "oauth-2025-04-20, mcp-client-2025-04-04" })).status).toBe(403);
    expect((await send("/v1/messages", { "anthropic-beta": "files-api-2025-04-14" })).status).toBe(403);
    expect((await send("/v1/messages", { "anthropic-beta": "MCP-Client-2025-11-20" })).status).toBe(403);
    expect((await send("/v1/messages", { "anthropic-beta": "skills-2025-10-02" })).status).toBe(403);
    expect(received).toEqual([]);
  });

  it("stops the upstream request when the agent disconnects", async () => {
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((r) => (upstreamClosed = r));
    const { send } = await setup("sk-ant-oat01-real", (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: 1\n\n");
      req.socket.on("close", upstreamClosed);
    });
    const abort = new AbortController();
    const res = await send("/v1/messages", {}, undefined, "POST", abort.signal);
    expect(res.status).toBe(200);
    abort.abort();
    await closed;
  });

  it("ends the agent's response when the upstream fails mid-stream", async () => {
    const { send } = await setup("sk-ant-oat01-real", (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: 1\n\n");
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const res = await send("/v1/messages");
    await expect(res.text()).rejects.toThrow();
  });

  it("answers 503 without a token", async () => {
    const { received, send } = await setup("");
    expect((await send("/v1/messages")).status).toBe(503);
    expect(received).toEqual([]);
  });
});
