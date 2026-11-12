/** Explicit one-shot local transport faults. Domain and immutable database records stay untouched. */
import { readFile, writeFile, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
export const audienceFaultModes = ["command-before-dispatch", "command-reply-lost", "work-reply-lost", "receipt-lookup-held", "message-hash-corrupted", "attendee-read-denied"];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
export async function createAudienceNativeFaults({ directory, origin, producerToken, attendeeTokens, cookieName, record }) {
  const filename = directory + "/fault-state.json"; let state;
  try { state = JSON.parse(await readFile(filename, "utf8")); if (state.version !== 1 || !Array.isArray(state.used) || state.used.some(mode => !audienceFaultModes.includes(mode))) throw new Error("Original fault ledger is invalid"); }
  catch (error) { if (error.code !== "ENOENT") throw error; state = { version: 1, armed: null, used: [] }; await writeFile(filename, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
  let held = null;
  const save = async () => { const next = filename + ".next-" + randomUUID(); await writeFile(next, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 }); await rename(next, filename); };
  const owner = request => request.headers.authorization === "Bearer " + producerToken || (request.headers.cookie ?? "").split(";").some(value => value.trim() === cookieName + "=" + producerToken);
  const attendee = request => attendeeTokens.some(token => request.headers.authorization === "Bearer " + token);
  async function consume(mode) { state.armed = null; state.used.push(mode); await save(); await record({ event: "controlled-transport-fault-consumed", mode, actualExternalRequest: false }); }
  function capture(response, complete) {
    const nativeEnd = response.end, chunks = []; let size = 0;
    const add = (chunk, encoding) => { if (chunk === undefined || chunk === null) return; const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined); size += bytes.length; if (size > 5_000_000) throw new Error("Controlled audience response exceeded its bound"); chunks.push(bytes); };
    response.write = function (chunk, encoding, callback) { try { add(chunk, encoding); if (typeof encoding === "function") encoding(); else callback?.(); return true; } catch { response.destroy(); return false; } };
    response.end = function (chunk, encoding, callback) {
      try { add(chunk, encoding); } catch { response.destroy(); return response; }
      void complete(Buffer.concat(chunks)).then(bytes => { if (bytes === null) return response.destroy(); if (!response.headersSent) { response.removeHeader("ETag"); response.setHeader("Content-Length", bytes.length); } nativeEnd.call(response, bytes, typeof encoding === "function" ? encoding : callback); }).catch(async () => { await record({ event: "controlled-fault-response-unverified", originalOutcome: "unknown" }).catch(() => {}); response.destroy(); });
      return response;
    };
  }
  return {
    state: () => ({ armed: state.armed, used: [...state.used], held: Boolean(held) }),
    async arm(mode) { if (!audienceFaultModes.includes(mode)) throw new Error("Choose a declared audience transport control"); if (state.armed || held || state.used.includes(mode)) throw new Error("An original arm or used one-shot control is retained; it cannot be reset"); state.armed = mode; await save(); await record({ event: "controlled-transport-fault-armed", mode }); },
    async cancel() { if (held) throw new Error("Release the original held read explicitly"); const prior = state.armed; state.armed = null; await save(); await record({ event: "unused-fault-arm-cancelled", mode: prior }); },
    async release() { if (!held) throw new Error("No original receipt read is held"); const current = held; held = null; await record({ event: "original-receipt-read-released", path: current.path, clientAlreadyClosed: current.response.destroyed }); if (!current.response.destroyed) await current.forward(); },
    async intercept(request, response, forward) {
      const path = new URL(request.url ?? "/", origin).pathname, mode = state.armed;
      if (!mode) return false;
      if (mode === "attendee-read-denied" && request.method === "GET" && path === "/api/attendee" && attendee(request)) { await consume(mode); await record({ event: "controlled-attendee-denial-triggered", status: 401, databaseCapabilityChanged: false }); response.writeHead(401, { "Content-Type": "text/plain", "Cache-Control": "private, no-store" }); response.end("Controlled unreadable access denial; not a database revocation"); return true; }
      if (!owner(request)) return false;
      if (mode === "receipt-lookup-held" && request.method === "GET" && /^\/api\/audience\/commands\/[a-f0-9-]{36}$/.test(path)) { await consume(mode); held = { path, response, forward }; await record({ event: "original-receipt-read-held", path, databaseMutation: false }); return true; }
      const command = request.method === "POST" && path === "/api/audience/commands" && request.headers.origin === origin, work = request.method === "POST" && path === "/api/audience/work" && request.headers.origin === origin, message = request.method === "GET" && /^\/api\/audience\/messages\/[a-f0-9-]{36}$/.test(path);
      if (mode === "command-before-dispatch" && command) { await consume(mode); await record({ event: "controlled-command-stopped-before-handler", status: 503, originalOutcome: "handler_not_invoked" }); response.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "private, no-store" }); response.end(JSON.stringify({ code: "CONTROLLED_BEFORE_DISPATCH", error: "Controlled response before the audience handler. Read the original command identity before an explicit retry." })); return true; }
      if (mode === "command-reply-lost" && command || mode === "work-reply-lost" && work || mode === "message-hash-corrupted" && message) {
        await consume(mode); request.headers["accept-encoding"] = "identity";
        capture(response, async bytes => {
          let body; try { body = JSON.parse(bytes.toString("utf8")); } catch { await record({ event: "controlled-fault-not-triggered", mode, status: response.statusCode, reason: "No verified JSON response" }); return bytes; }
          if (response.statusCode !== 200 || (mode === "message-hash-corrupted" ? !body.draft?.recipients?.[0]?.content : !body.receipt?.commandId)) { await record({ event: "controlled-fault-not-triggered", mode, status: response.statusCode }); return bytes; }
          if (mode === "message-hash-corrupted") { body.draft.recipients[0].content.body += "\nControlled unreviewed transport corruption; original database content is unchanged."; await record({ event: "controlled-preview-hash-corrupted", mode, originalResponseSha256: sha(bytes), databaseMutation: false }); return Buffer.from(JSON.stringify(body)); }
          await record({ event: mode === "work-reply-lost" ? "actual-work-reply-withheld" : "actual-command-reply-withheld", mode, commandId: body.receipt.commandId, requestDigest: body.receipt.requestDigest, receiptSha256: sha(JSON.stringify(body.receipt)), originalOutcome: "receipt_committed; delivery_requires_individual_receipts" }); return null;
        });
        await forward(); return true;
      }
      return false;
    },
  };
}
