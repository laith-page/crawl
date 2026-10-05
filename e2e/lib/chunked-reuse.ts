// A two-request HTTP/1.1 fixture. faulty closes after a raw response, so it cannot serve a
// chunked gzip body and then answer a second request on that same connection.
import { createServer, type AddressInfo, type Socket } from "node:net";
import { gzipSync } from "node:zlib";

const path = "/chunked-reuse/";
const compressed = gzipSync(Buffer.from(`<a href="${path}after">next</a>`));
const first = Buffer.concat([
  Buffer.from(
    "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-encoding: gzip\r\ntransfer-encoding: chunked\r\n\r\n",
  ),
  Buffer.from(`${compressed.length.toString(16)}\r\n`),
  compressed,
  Buffer.from("\r\n0\r\n\r\n"),
]);
const second = "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
const wrongConnection = "HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";

/** What the n-th request on the m-th connection is answered with, and whether the connection closes after. */
function reply(connection: number, sequence: number, text: string): { bytes: string | Buffer; close?: boolean } {
  if (connection === 1 && sequence === 1 && text.startsWith(`GET ${path} HTTP/1.1`)) return { bytes: first };
  if (connection === 1 && sequence === 2 && text.startsWith(`GET ${path}after HTTP/1.1`))
    return { bytes: second, close: true };
  return { bytes: wrongConnection, close: true };
}

export async function startChunkedReuse(): Promise<{ port: number; stop: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer((socket) => {
    const connection = ++connections;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let pending = Buffer.alloc(0);
    let sequence = 0;
    socket.on("data", (bytes) => {
      pending = Buffer.concat([pending, Buffer.from(bytes)]);
      let end: number;
      while ((end = pending.indexOf("\r\n\r\n")) >= 0) {
        const text = pending.subarray(0, end + 4).toString();
        pending = pending.subarray(end + 4);
        const answer = reply(connection, ++sequence, text);
        if (answer.close) {
          socket.end(answer.bytes);
          break;
        }
        socket.write(answer.bytes);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
