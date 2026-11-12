import { startIntelligenceSchema, type IntelligenceRunView, type StartIntelligence } from "@/domain/intelligence";
import { productionFetch } from "../production-fetch";

export interface PlanningDispatchScope { tenantId: string; sessionExpiresAt: string; sessionAccessId: string }
export interface RetainedPlanningInstruction extends PlanningDispatchScope { version: 1; command: StartIntelligence }
type Transport = typeof productionFetch;
const rejectedBeforeReservation = new Set([
  "INVALID_PLANNING_COMMAND", "PLANNING_REVIEW_REQUIRED", "PLANNING_SESSION_ENDED", "PLANNING_ROLE_REQUIRED",
  "PLANNING_NOT_CONFIGURED", "PLANNING_PENDING", "PLANNING_FIRST_TURN", "PLANNING_LEGACY_READ_ONLY",
  "PLANNING_HISTORY_CHANGED", "PLANNING_CONVERSATION_FULL", "PLANNING_TOOL_PENDING", "PLANNING_CONTINUATION",
  "PLANNING_HISTORY_TOO_LARGE", "SESSION_REQUIRED", "PRODUCTION_CHANGED", "PRODUCTION_SCOPE_REQUIRED",
]);
export const planningRequestKey = (tenantId: string, conversationId: string) => `opening-night-planning:${tenantId}:${conversationId}`;
const instructionKey = (key: string) => `${key}:instruction`;
export function clearExactPlanningRequest(key: string, requestId: string, storage: Storage = sessionStorage) {
  if (storage.getItem(key) !== requestId) return;
  storage.removeItem(key); storage.removeItem(instructionKey(key));
}
export function readPlanningInstruction(key: string, storage: Storage = sessionStorage): RetainedPlanningInstruction | null {
  try {
    const saved = JSON.parse(storage.getItem(instructionKey(key)) ?? "null") as RetainedPlanningInstruction | null;
    if (!saved || saved.version !== 1 || typeof saved.tenantId !== "string" || typeof saved.sessionExpiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(saved.sessionExpiresAt) || !/^[a-f0-9]{64}$/.test(saved.sessionAccessId)) return null;
    const command = startIntelligenceSchema.parse(saved.command);
    if (planningRequestKey(saved.tenantId, command.conversationId) !== key || storage.getItem(key) !== command.requestId) return null;
    return { version: 1, tenantId: saved.tenantId, sessionExpiresAt: saved.sessionExpiresAt, sessionAccessId: saved.sessionAccessId, command };
  } catch { return null; }
}
function exactRun(value: unknown, command: StartIntelligence): IntelligenceRunView {
  const run = value as IntelligenceRunView | null;
  if (!run || run.requestId !== command.requestId || run.conversationId !== command.conversationId || typeof run.id !== "string" || !/^[a-f0-9-]{36}$/.test(run.id) || !["dispatching", "running", "completed", "failed", "indeterminate", "unavailable"].includes(run.state)) throw new Error("The original response identity could not be verified. Its request is retained.");
  return run;
}
async function originalRead(saved: RetainedPlanningInstruction, transport: Transport, signal?: AbortSignal) {
  const response = await transport(saved.tenantId, `/api/intelligence?requestId=${saved.command.requestId}`, { cache: "no-store", ...(signal ? { signal } : {}) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("The original request could not be read. Its instruction is retained; no replacement was sent.");
  return exactRun(await response.json(), saved.command);
}
async function send(saved: RetainedPlanningInstruction, storage: Storage, transport: Transport, signal?: AbortSignal) {
  const key = planningRequestKey(saved.tenantId, saved.command.conversationId);
  let response: Response | undefined, value: { code?: string; error?: string } | undefined;
  try {
    response = await transport(saved.tenantId, "/api/intelligence", { method: "POST", headers: { "Content-Type": "application/json", "x-opening-night-planning-expiry": saved.sessionExpiresAt, "x-opening-night-planning-access": saved.sessionAccessId }, body: JSON.stringify(saved.command), ...(signal ? { signal } : {}) });
    value = await response.json();
    if (response.ok) return exactRun(value, saved.command);
  } catch (error) { if (signal?.aborted) throw error; }
  if (response && response.status >= 400 && response.status < 500 && value?.code && rejectedBeforeReservation.has(value.code)) {
    clearExactPlanningRequest(key, saved.command.requestId, storage);
    throw new Error(value.error ?? "This instruction was refused before a model request was reserved.");
  }
  const recovered = await originalRead(saved, transport, signal);
  if (!recovered) throw new Error("The original request outcome is uncertain. Its exact instruction is retained for review and recovery.");
  return recovered;
}
export async function dispatchPlanningInstruction(scope: PlanningDispatchScope, raw: StartIntelligence, signal?: AbortSignal, storage: Storage = sessionStorage, transport: Transport = productionFetch) {
  const command = startIntelligenceSchema.parse(raw), key = planningRequestKey(scope.tenantId, command.conversationId);
  if (storage.getItem(key)) throw new Error("A saved instruction still needs its exact result. No replacement request was sent.");
  const saved: RetainedPlanningInstruction = { version: 1, tenantId: scope.tenantId, sessionExpiresAt: scope.sessionExpiresAt, sessionAccessId: scope.sessionAccessId, command };
  // Persist both before dispatch. A storage failure must prevent the request.
  storage.setItem(instructionKey(key), JSON.stringify(saved)); storage.setItem(key, command.requestId);
  return send(saved, storage, transport, signal);
}
/** Called only by an explicit same-instruction retry; read the exact original first. */
export async function retryPlanningInstruction(scope: PlanningDispatchScope, saved: RetainedPlanningInstruction, signal?: AbortSignal, storage: Storage = sessionStorage, transport: Transport = productionFetch) {
  const key = planningRequestKey(saved.tenantId, saved.command.conversationId), retained = readPlanningInstruction(key, storage);
  if (!retained || JSON.stringify(retained) !== JSON.stringify(saved) || scope.tenantId !== saved.tenantId || scope.sessionExpiresAt !== saved.sessionExpiresAt || scope.sessionAccessId !== saved.sessionAccessId || Date.parse(saved.sessionExpiresAt) <= Date.now()) throw new Error("This instruction belongs to different or ended original access. It cannot adopt the current session.");
  const original = await originalRead(saved, transport, signal);
  return original ?? send(saved, storage, transport, signal);
}
