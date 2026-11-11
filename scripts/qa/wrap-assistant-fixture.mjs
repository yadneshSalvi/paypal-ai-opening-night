// Controlled model transport for the actual bounded assistant service. No model/provider egress.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
/** @param {{storePath?: string,beforeCall?: (call: any) => Promise<void>}} options */
export function createWrapAssistantFixture(options = {}) {
  const calls = [], responses = new Map(options.storePath && existsSync(options.storePath) ? JSON.parse(readFileSync(options.storePath, "utf8")).responses : []);
  const save = () => { if (options.storePath) { const temporary = `${options.storePath}.${randomUUID()}`; writeFileSync(temporary, JSON.stringify({ responses: [...responses] }), { mode: 0o600 }); renameSync(temporary, options.storePath); } };
  /** @type {{loseCreate:boolean,queued:boolean,wrongIdentity:boolean,tool:string|null,args:any}} */
  const behavior = { loseCreate: false, queued: false, wrongIdentity: false, tool: null, args: null };
  const complete = (id, body, previous) => {
    const step = previous ? previous.step + 1 : 1, accountText = body.input?.find(value => value.role === "developer")?.content, initial = previous?.facts ?? (typeof accountText === "string" ? JSON.parse(accountText.slice(accountText.indexOf("{"))) : null), result = previous ? JSON.parse(body.input[0].output) : null, facts = result?.data?.lines ? result.data : initial;
    let name = step === 1 ? "readAccount" : step === 2 && facts.resources?.length ? "readPayPalRecord" : step <= 3 && facts.lines?.length && previous?.name !== "proposeReview" ? "proposeReview" : null;
    let args = name === "readAccount" ? {} : name === "readPayPalRecord" ? { resourceRef: facts.resources[0].ref } : name === "proposeReview" ? { title: "Review unresolved production sources", detail: "Review the selected retained sources and their unknown fees before sealing a new account edition. This proposal grants no financial authority.", lineRefs: facts.lines.slice(0, 3).map(value => value.ref) } : null;
    if (behavior.tool) { name = behavior.tool; args = behavior.args ?? {}; }
    const output = name ? [{ type: "function_call", call_id: "call_wrap_" + randomUUID().replaceAll("-", ""), name, arguments: JSON.stringify(args) }] : [{ type: "message", content: [{ type: "output_text", text: `The current account retains ${facts?.denominator?.ledgerLines ?? 0} rows. ${facts?.totals?.unknownFeeCount ?? 0} rows have incomplete fees. Review ${facts?.lines?.map(value => value.ref).join(", ") || "the current source manifest"} before sealing. The saved proposal is unapproved; no invoice or transfer was created.` }] }];
    return { id, status: "completed", output, step, facts, name };
  };
  const provider = { configured: true, mode: "controlled_fixture", fetch: async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init), url = new URL(request.url);
    if (url.origin !== "https://api.openai.com" || !/^\/v1\/responses(?:\/resp_[A-Za-z0-9_-]+)?$/.test(url.pathname) || url.search) throw new Error("Controlled model fixture refused an unexpected destination");
    const body = request.method === "POST" ? JSON.parse(await request.text()) : null, call = { method: request.method, path: url.pathname, body }; calls.push(call); await options.beforeCall?.(call);
    if (request.method === "POST" && url.pathname === "/v1/responses") {
      if (body.model !== "gpt-6.1-sol" || body.reasoning?.effort !== "max" || body.background !== true || body.store !== true || body.parallel_tool_calls !== false || body.tools?.map(value => value.name).sort().join(",") !== "proposeReview,readAccount,readPayPalRecord") throw new Error("Controlled model fixture refused a widened model or tool policy");
      const previous = body.previous_response_id ? responses.get(body.previous_response_id) : null;
      if (body.previous_response_id && !previous) throw new Error("Unknown original controlled response");
      const id = "resp_wrap_" + randomUUID().replaceAll("-", ""), value = complete(id, body, previous); responses.set(id, value); save();
      if (behavior.loseCreate) throw new Error("Controlled lost model response after original request");
      return Response.json(behavior.queued ? { id, status: "queued", output: [] } : { id, status: value.status, output: value.output });
    }
    if (request.method === "GET") { const id = url.pathname.split("/").at(-1), value = responses.get(id); if (!value) return Response.json({ error: "Controlled original not found" }, { status: 404 }); return Response.json({ id: behavior.wrongIdentity ? "resp_wrong_identity" : id, status: value.status, output: value.output }); }
    throw new Error("Controlled model fixture refused a non-response operation");
  } };
  return { provider, calls, responses, behavior };
}
