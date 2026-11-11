import { z } from "zod";
export const wrapAssistantTools = {
  readAccount: z.object({}).strict(),
  readPayPalRecord: z.object({ resourceRef: z.string().regex(/^R\d{1,3}$/) }).strict(),
  proposeReview: z.object({ title: z.string().trim().min(3).max(160), detail: z.string().trim().min(12).max(2400), lineRefs: z.array(z.string().regex(/^L\d{1,3}$/)).min(1).max(30) }).strict(),
};
export type WrapAssistantTool = keyof typeof wrapAssistantTools;
export const wrapAssistantStart = z.object({ requestId: z.uuid().transform(value => value.toLowerCase()), prompt: z.string().trim().min(3).max(3000), reportDigest: z.string().regex(/^[a-f0-9]{64}$/), expectedRevision: z.number().int().min(0), expectedShowRevision: z.number().int().positive(), lineIds: z.array(z.string().min(1).max(180)).max(30) }).strict();
export interface WrapAssistantCall { id: string; name: WrapAssistantTool; args: unknown }
export interface WrapAssistantView { id: string; requestId: string; prompt: string; createdAt: string; expiresAt: string; sourceDigest: string; state: "working" | "ready" | "completed" | "failed" | "unknown" | "expired"; provenance: "live_model" | "controlled_fixture"; model: "gpt-6.1-sol"; reasoning: "max"; canContinue: boolean; messages: { step: number; text: string; call: WrapAssistantCall | null }[]; steps: { name: string; state: string; summary: string; receiptId: string | null }[]; problem: string | null; selectedCount: number; totalCount: number; bindings: { ref: string; lineIds: string[] }[] }
export interface WrapAssistantWorkspace { available: boolean; provenance: "live_model" | "controlled_fixture" | "unavailable"; runs: WrapAssistantView[]; total: number; nextCursor: string | null }
