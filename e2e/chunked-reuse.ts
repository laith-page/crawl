// A two-request HTTP/1.1 fixture. faulty closes after a raw response, so it cannot serve a
// chunked gzip body and then answer a second request on that same connection.
import { gzipSync } from "node:zlib";
import { startHttpScript } from "@tools/core";

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

export async function startChunkedReuse(): Promise<{ port: number; stop: () => Promise<void> }> {
  return startHttpScript(({ connection, sequence, text }) => {
    if (connection === 1 && sequence === 1 && text.startsWith(`GET ${path} HTTP/1.1`)) return { bytes: first };
    if (connection === 1 && sequence === 2 && text.startsWith(`GET ${path}after HTTP/1.1`))
      return { bytes: second, close: true };
    return { bytes: wrongConnection, close: true };
  });
}
