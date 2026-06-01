import type { IncomingMessage, ServerResponse } from "node:http";

export async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

export function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown
): void {
  const body = JSON.stringify(value, null, 2);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

export function wantsNdjson(request: IncomingMessage): boolean {
  const accept = request.headers.accept;
  const values = Array.isArray(accept) ? accept : [accept];
  return values.some((value) =>
    value?.toLowerCase().includes("application/x-ndjson")
  );
}

export function startNdjson(response: ServerResponse, status = 202): void {
  response.writeHead(status, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
}

export function writeNdjson(response: ServerResponse, value: unknown): void {
  response.write(`${JSON.stringify(value)}\n`);
}
