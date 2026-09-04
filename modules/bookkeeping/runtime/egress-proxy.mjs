import { lookup } from "node:dns/promises";
import http from "node:http";
import net from "node:net";

const port = Number(process.env.PORT ?? 3128);

function privateIpv4(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
    || a === 192 && b === 168 || a === 198 && (b === 18 || b === 19) || a >= 224;
}

async function publicAddress(hostname) {
  if (!hostname || hostname === "localhost") throw new Error("Private destination");
  const addresses = await lookup(hostname, { all: true, family: 4, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => privateIpv4(address))) throw new Error("Private destination");
  return addresses[0].address;
}

function fail(response, status, message) {
  if (response.headersSent) return response.destroy();
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(`${message}\n`);
}

function headers(source, host) {
  const result = { ...source, host };
  for (const name of ["proxy-authorization", "proxy-connection", "connection", "cookie", "authorization"]) delete result[name];
  return result;
}

const server = http.createServer(async (request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    return response.end('{"status":"ok"}');
  }
  try {
    const target = new URL(request.url ?? "");
    if (target.protocol !== "http:" || target.port && target.port !== "80") return fail(response, 403, "Only public HTTP is allowed");
    const upstream = http.request({ host: await publicAddress(target.hostname), port: 80, method: request.method, path: `${target.pathname}${target.search}`, headers: headers(request.headers, target.host), timeout: 30_000 }, (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.pipe(response);
    });
    upstream.on("error", () => fail(response, 502, "Upstream request failed"));
    request.pipe(upstream);
  } catch { fail(response, 403, "Destination is not allowed"); }
});

server.on("connect", async (request, socket, head) => {
  try {
    const target = new URL(`https://${request.url}`);
    if (Number(target.port || 443) !== 443) throw new Error("Only HTTPS 443 is allowed");
    const upstream = net.connect({ host: await publicAddress(target.hostname), port: 443, timeout: 30_000 }, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
  } catch { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); }
});

server.listen(port, "0.0.0.0");
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
