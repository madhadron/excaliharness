// The egress proxy (D-066, D-079), run in its own hardened container on both
// the internal and the egress network (D-060). Agents reach Claude's API only
// through it; it adds the real token, which never enters an agent container.
// It forwards only Messages requests, and refuses the API features that make
// Claude's servers contact other hosts or keep data (MCP servers, server
// tools, containers, files). It logs methods, paths and status codes, never
// header values or bodies.
import * as http from "node:http";
import * as https from "node:https";
import { pipeline } from "node:stream";

export const UPSTREAM_HOST = "api.anthropic.com";

const ALLOWED_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
const MAX_BODY = 32 * 1024 * 1024;
const MAX_DEPTH = 64;

// Whether arrays and objects nest deeper than `max`, checked without
// recursion so the check itself can't overflow the stack.
export function tooDeep(value: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[value, 0]];
  for (let next = stack.pop(); next; next = stack.pop()) {
    const [item, depth] = next;
    if (typeof item !== "object" || item === null) continue;
    if (depth >= max) return true;
    for (const child of Array.isArray(item) ? item : Object.values(item)) stack.push([child, depth + 1]);
  }
  return false;
}

// Headers that are about one hop or carry credentials; everything else goes
// through as sent.
const HOP = ["connection", "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];
const DROPPED_REQUEST = new Set(["host", "authorization", "x-api-key", "content-length", "expect", ...HOP]);
const DROPPED_RESPONSE = new Set(HOP);

// Betas for features that reach other hosts or store data.
const REFUSED_BETA = /^(mcp-client|code-execution|files-api|web-fetch|web-search|computer-use|skills)/i;

// Content sources that carry their data inline; any other (a URL, a file ID)
// makes Claude's servers fetch something.
const INLINE_SOURCES = new Set(["base64", "text", "content"]);

export interface ProxyOptions {
  token: string;
  log?: (line: string) => void;
  // For tests: where to send requests instead of Claude's API.
  upstream?: { request: typeof https.request; host: string };
}

// Agent-supplied text in a log line, quoted so it can't forge another line.
const quoted = (value: unknown) => JSON.stringify(typeof value === "string" ? value.slice(0, 60) : typeof value);

// Why a request body is refused, if it is.
export function bodyRefusal(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "the body isn't a JSON object";
  const fields = body as Record<string, unknown>;
  if ("mcp_servers" in fields) return "MCP servers aren't allowed";
  if ("container" in fields) return "containers aren't allowed";
  if (fields.tools !== undefined) {
    if (!Array.isArray(fields.tools)) return "tools isn't a list";
    for (const tool of fields.tools as unknown[]) {
      const type = typeof tool === "object" && tool !== null ? (tool as Record<string, unknown>).type : undefined;
      if (type !== undefined && type !== "custom") return `server tools aren't allowed (${quoted(type)})`;
    }
  }
  return sourceRefusal(fields.messages) ?? sourceRefusal(fields.system);
}

// Image and document blocks anywhere in the messages (tool results
// included) must carry their data, not a URL or file to fetch.
function sourceRefusal(value: unknown, depth = 0): string | undefined {
  if (depth > 64) return "the body is nested too deeply";
  if (Array.isArray(value)) {
    for (const item of value) {
      const why = sourceRefusal(item, depth + 1);
      if (why) return why;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const fields = value as Record<string, unknown>;
  const source = fields.source;
  if (typeof source === "object" && source !== null && !Array.isArray(source)) {
    const type = (source as Record<string, unknown>).type;
    if (typeof type !== "string" || !INLINE_SOURCES.has(type)) return `content fetched from elsewhere isn't allowed (source type ${quoted(type)})`;
  }
  // The source too: a `content` source holds blocks of its own.
  for (const child of Object.values(fields)) {
    const why = sourceRefusal(child, depth + 1);
    if (why) return why;
  }
  return undefined;
}

// Headers a Connection header names are about this hop too.
const connectionNamed = (header: string | undefined) => new Set((header ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));

export function betaRefusal(header: string | string[] | undefined): string | undefined {
  const values = (Array.isArray(header) ? header.join(",") : (header ?? "")).split(",").map((v) => v.trim()).filter(Boolean);
  const refused = values.find((v) => REFUSED_BETA.test(v));
  return refused ? `the ${quoted(refused)} beta isn't allowed` : undefined;
}

export function createProxy(options: ProxyOptions): http.Server {
  const log = options.log ?? ((line: string) => console.log(line));
  const upstream = options.upstream ?? { request: https.request, host: UPSTREAM_HOST };
  return http.createServer((req, res) => {
    const method = req.method ?? "?";
    const pathOnly = (req.url ?? "").split("?")[0] ?? "";
    const refuse = (status: number, why: string) => {
      log(`refused ${method} ${pathOnly.slice(0, 80)}: ${why}`);
      if (!res.headersSent) res.writeHead(status, { "content-type": "text/plain", connection: "close" });
      res.end(`${why}\n`);
      req.resume();
    };
    if (method !== "POST" || !ALLOWED_PATHS.has(pathOnly)) return refuse(403, "Only Claude's Messages API is reachable from here.");
    if (!options.token) return refuse(503, "The proxy has no token yet.");
    const beta = betaRefusal(req.headers["anthropic-beta"]);
    if (beta) return refuse(403, beta);

    // The body is read whole so it can be checked before anything is sent.
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size <= MAX_BODY) {
        chunks.push(chunk);
        return;
      }
      tooLarge = true;
      log(`refused ${method} ${pathOnly}: too large`);
      res.writeHead(413, { "content-type": "text/plain", connection: "close" }).end("The request is too large.\n", () => req.destroy());
    });
    req.on("error", () => res.destroy());
    req.on("end", () => {
      if (tooLarge) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks.splice(0)).toString("utf8"));
      } catch {
        return refuse(400, "The body isn't JSON.");
      }
      // Anything nested deeper than real requests are would overflow the
      // checks or the re-serializing below and crash the proxy.
      if (tooDeep(parsed, MAX_DEPTH)) return refuse(400, "The body is nested too deeply.");
      let body: Buffer;
      try {
        const why = bodyRefusal(parsed);
        if (why) return refuse(403, why);
        // What was checked is what is sent: re-serialized, so duplicate keys
        // can't be read differently upstream.
        body = Buffer.from(JSON.stringify(parsed));
      } catch {
        return refuse(400, "The body can't be checked.");
      }
      forward(body);
    });

    function forward(body: Buffer): void {
      const headers: http.OutgoingHttpHeaders = {};
      const named = connectionNamed(req.headers.connection);
      for (const [name, value] of Object.entries(req.headers)) if (!DROPPED_REQUEST.has(name) && !named.has(name) && value !== undefined) headers[name] = value;
      headers.host = upstream.host;
      headers.authorization = `Bearer ${options.token}`;
      headers["content-length"] = body.length;
      const outgoing = upstream.request({ host: upstream.host, path: req.url, method, headers, timeout: 15 * 60_000 }, (reply) => {
        log(`${method} ${pathOnly} ${reply.statusCode ?? "?"}`);
        const replyHeaders: http.OutgoingHttpHeaders = {};
        const replyNamed = connectionNamed(reply.headers.connection);
        for (const [name, value] of Object.entries(reply.headers)) if (!DROPPED_RESPONSE.has(name) && !replyNamed.has(name) && value !== undefined) replyHeaders[name] = value;
        res.writeHead(reply.statusCode ?? 502, replyHeaders);
        // An upstream failure mid-stream ends the agent's response too.
        pipeline(reply, res, (error) => {
          if (error) log(`${method} ${pathOnly} stream ended early: ${error.code ?? error.message}`);
        });
      });
      // The agent went away: stop the upstream request, which may be
      // streaming (and spending) for minutes.
      res.on("close", () => {
        if (!res.writableFinished) outgoing.destroy();
      });
      outgoing.on("timeout", () => outgoing.destroy(new Error("upstream timed out")));
      outgoing.on("error", (error: NodeJS.ErrnoException) => {
        log(`${method} ${pathOnly} upstream error ${error.code ?? error.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end();
      });
      outgoing.end(body);
    }
  });
}
