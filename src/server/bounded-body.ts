import { DomainError } from "@/domain/contracts";

export async function boundedBytes(body: Request | Response, maximumBytes: number) {
  if (Number(body.headers.get("content-length") ?? 0) > maximumBytes) throw new DomainError("REQUEST_TOO_LARGE", "This message exceeds the agreed request size.", 413);
  const reader = body.body?.getReader(); if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) { await reader.cancel(); throw new DomainError("REQUEST_TOO_LARGE", "This message exceeds the agreed request size.", 413); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
export async function boundedText(body: Request | Response, maximumBytes: number) {
  const bytes = await boundedBytes(body, maximumBytes);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new DomainError("INVALID_TEXT_ENCODING", "This request must contain valid UTF-8 text.", 400); }
}
export async function boundedJson(request: Request, maximumBytes: number) { return JSON.parse(await boundedText(request, maximumBytes)) as unknown; }
