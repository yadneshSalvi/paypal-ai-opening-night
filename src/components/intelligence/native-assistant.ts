"use client";
import { OpenAIPlugin } from "@bryntum/core-enterprise";
import type { Gantt } from "@bryntum/gantt-enterprise";
import DefaultGanttAgent, { type NativeTool, type NativeToolInput } from "@bryntum/gantt-enterprise/lib/Gantt/feature/ai/agents/DefaultGanttAgent.js";
import GanttToolHost from "@bryntum/gantt-enterprise/lib/Gantt/feature/ai/toolhosts/GanttToolHost.js";
import { intelligenceToolDefinitions, intelligenceTools, type IntelligenceConversation, type IntelligenceRunView, type IntelligenceTool, type IntelligenceToolResult } from "@/domain/intelligence";
import { productionFetch } from "../production-fetch";
import { nativeAudioTrigger } from "./native-voice";
import { clearExactPlanningRequest, dispatchPlanningInstruction } from "./planning-dispatch";
import { readablePlanningChatPanel, ReadablePlanningChatPopup } from "./planning-chat";
import { planningChecklistHtml, planningPopupBounds } from "./chat-layout";
import { safePlanningMessageHtml } from "./safe-message";

export interface NativePlanningOptions {
  tenantId: string; initial: IntelligenceConversation | null; sessionExpiresAt: string; sessionAccessId: string;
  onRun: (run: IntelligenceRunView) => void; onTool: (result: IntelligenceToolResult) => void;
  onVoiceSaved?: () => void;
  onInstructionHeld?: (requestId: string) => void;
}
const base = "/api/intelligence";
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException("The saved request is retained.", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}
export function savedNativeMessages(saved: IntelligenceConversation | null) {
  if (!saved) return [{ id: "opening-welcome", fromOther: true, text: "Let’s find the next safe move. Ask about a crew assignment or compare the saved recovery plans." }];
  return saved.runs.flatMap(run => {
    const entries: { id: string; fromOther: boolean; text: string; options?: string[] }[] = [];
    const prompt = saved.prompts.find(item => item.runId === run.id);
    if (prompt) entries.push({ id: `${run.id}-user`, fromOther: false, text: prompt.text });
    const message = run.result?.choices[0].message;
    if (message?.content) entries.push({ id: `${run.id}-assistant`, fromOther: true, text: message.content });
    for (const call of message?.tool_calls ?? []) {
      const receipt = saved.receipts.find(row => row.runId === run.id && row.callId === call.id);
      if (call.function.name === "askUser") {
        const args = intelligenceTools.askUser.parse(JSON.parse(call.function.arguments));
        entries.push({ id: `${run.id}-question`, fromOther: true, text: args.question, ...(receipt?.result.ok && saved.runs.at(-1)?.id === run.id ? { options: args.options } : {}) });
      } else if (receipt && !receipt.result.ok) entries.push({ id: `${run.id}-receipt`, fromOther: true, text: `Saved check · held\n${receipt.result.message}` });
      else if (receipt?.result.name === "checkAssignment") {
        const checked = receipt.result.data as { taskName: string; allowedByQualification: boolean; issues: { message: string; sourceId: string }[] };
        entries.push({ id: `${run.id}-receipt`, fromOther: true, text: `Saved qualification check · ${checked.taskName}\n${checked.allowedByQualification ? "Qualification confirmed. No assignment changed." : checked.issues.map(issue => `${issue.message} [${issue.sourceId}]`).join("\n")}` });
      } else if (receipt?.result.name === "proposeRecovery") entries.push({ id: `${run.id}-receipt`, fromOther: true, text: `Saved alternative\n${receipt.result.message}` });
      else if (receipt) continue; // Native checklist and the decision record retain these receipts.
      else entries.push({ id: `${run.id}-held`, fromOther: true, text: "This saved step needs recovery in the decision record below. It has not been repeated." });
    }
    if (["dispatching", "running", "indeterminate", "failed", "unavailable"].includes(run.state)) entries.push({ id: `${run.id}-state`, fromOther: true, text: run.message });
    return entries;
  });
}
export function nativeProductionAssistant(options: NativePlanningOptions) {
  const draftKey = `opening-night-draft-conversation:${options.tenantId}`, savedDraft = sessionStorage.getItem(draftKey);
  const conversationId = options.initial?.id ?? (savedDraft && /^[a-f0-9-]{36}$/.test(savedDraft) ? savedDraft : crypto.randomUUID());
  sessionStorage.setItem(draftKey, conversationId);
  let lastRunId: string | null = options.initial?.runs.at(-1)?.id ?? null;
  const storageKey = `opening-night-planning:${options.tenantId}:${conversationId}`;
  const voiceQuery = new URLSearchParams({ production: options.tenantId, scope: conversationId }).toString();
  class ProductionToolHost extends GanttToolHost { static $name = "OpeningNightProposalHost"; override get tools() { return this._configuredTools; } }
  const execute = async (name: IntelligenceTool, input: NativeToolInput) => {
    if (!lastRunId || !input.toolCall?.id) throw new Error("Only an exact saved response can invoke this planning step.");
    const response = await productionFetch(options.tenantId, `${base}/tools`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: lastRunId, callId: input.toolCall.id, name, args: input.args }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "The saved planning step could not be recovered.");
    options.onTool(result); return result as IntelligenceToolResult;
  };
  class ProductionAgent extends DefaultGanttAgent {
    static $name = "OpeningNightProductionAgent";
    showPlan(plan: NonNullable<IntelligenceConversation["plan"]>) {
      const widget = this.client.features.ai.chatPanel?.widgetMap.openingPlan; if (!widget) return;
      widget.html = planningChecklistHtml(plan, widget.element?.querySelector("details")?.open ?? false);
      widget.hidden = false;
    }
    override get agentTools() {
      const native = super.agentTools;
      const wrap = (name: "askUser" | "createPlan" | "completePlanSteps"): NativeTool => ({ ...native[name]!, available: true,
        parameters: intelligenceToolDefinitions.find(tool => tool.name === name)!.parameters,
        fn: async (input: NativeToolInput) => {
          const result = await execute(name, input);
          if (!result.ok) return result;
          if (options.initial?.plan && !this.$plan) this.$plan = structuredClone(options.initial.plan);
          await native[name]!.fn(input);
          if (name !== "askUser") {
            const plan = (result.data as { plan: NonNullable<IntelligenceConversation["plan"]> }).plan;
            this.showPlan(plan); this.$plan = structuredClone(plan);
          }
          return result;
        },
      });
      return { askUser: wrap("askUser"), createPlan: wrap("createPlan"), completePlanSteps: wrap("completePlanSteps") };
    }
    override processResponse(response: unknown, context: Record<string, unknown>) {
      context.planNudgeCount = 3; // Only the explicit operator turn and saved tool continuations dispatch.
      return super.processResponse(response, context);
    }
    post(body: Record<string, unknown>) {
      const controller = new AbortController(); this.beforePost?.(body);
      const promise = (async () => {
        if (options.initial?.pending || sessionStorage.getItem(storageKey)) throw new Error("A saved step needs recovery in the decision record below. No replacement request was sent.");
        const messages = body.messages as { role: string; content?: unknown }[];
        const last = messages.at(-1), prompt = last?.role === "user" && typeof last.content === "string" ? last.content : null;
        const requestId = crypto.randomUUID();
        let run: IntelligenceRunView;
        try { run = await dispatchPlanningInstruction(options, { requestId, conversationId, afterRunId: lastRunId, prompt }, controller.signal); }
        catch (error) { if (sessionStorage.getItem(storageKey) === requestId) options.onInstructionHeld?.(requestId); throw error; }
        options.onRun(run); lastRunId = run.id;
        const until = Date.now() + 12 * 60_000;
        while (["dispatching", "running"].includes(run.state) && Date.now() < until) {
          await pause(run.retryAfterMs, controller.signal);
          try {
            const response = await productionFetch(options.tenantId, `${base}?runId=${run.id}`, { cache: "no-store", signal: controller.signal });
            if (response.ok) { run = await response.json(); options.onRun(run); }
          } catch (error) { if (controller.signal.aborted) throw error; }
        }
        if (!["dispatching", "running", "indeterminate"].includes(run.state)) clearExactPlanningRequest(storageKey, requestId);
        if (run.state !== "completed" || !run.result) throw new Error(run.message);
        return { ok: true, parsedJson: structuredClone(run.result) };
      })();
      return Object.assign(promise, { abort: () => controller.abort() });
    }
  }
  const customTools = Object.fromEntries(intelligenceToolDefinitions.filter(tool => !["askUser", "createPlan", "completePlanSteps"].includes(tool.name)).map(tool => [tool.name, { ...tool, kind: "read", available: true, noStm: true, fn: (input: NativeToolInput) => execute(tool.name, input) }]));
  const plan = options.initial?.plan;
  const config = {
    apiPlugin: OpenAIPlugin, agent: ProductionAgent, toolHost: ProductionToolHost, tools: customTools,
    model: "gpt-6.1-sol", promptUrl: base, manageChatHistory: false, planning: true,
    timeout: 15 * 60_000, debugMode: false, showNoConnectionIcon: false, undo: false, redo: false, mentions: false,
    autoReadAloud: false, autoRecord: false, stopAudioOnHide: true, voiceOnly: false, availableApis: [],
    transcribeUrl: `${base}/voice/transcribe?${voiceQuery}`, textToSpeechUrl: `${base}/voice/speak?${voiceQuery}`,
    chatButton: { changeChatPanel: readablePlanningChatPanel, text: "Plan the next move", cls: "opening-native-assistant", tooltip: "Open the production planning desk", chatPanel: {
      type: ReadablePlanningChatPopup.type, voiceProduction: options.tenantId, onVoiceSaved: options.onVoiceSaved,
      showRecordButton: true, showReadAloud: true,
      title: "The next safe move", cls: "opening-native-planner", ...planningPopupBounds({ width: window.visualViewport?.width || window.innerWidth, height: window.visualViewport?.height || window.innerHeight }),
      showAnimation: false, hideAnimation: false, animateTyping: false, formatText: safePlanningMessageHtml,
      messages: savedNativeMessages(options.initial).map(message => ({ ...message, text: safePlanningMessageHtml(message.text) })), tools: { settingsTool: false, clearChat: false },
      items: {
        messageField: { maxHeight: 112, triggers: { mic: nativeAudioTrigger("Record a planning draft"), send: nativeAudioTrigger("Send planning request"), stop: nativeAudioTrigger("Stop audio or planning response") } },
        openingVoiceStatus: { type: "widget", weight: 190, cls: "opening-native-voice-status", html: '<details class="opening-native-voice-help"><summary>Voice & draft help</summary><p>Record when ready. Review the editable transcript, then Send. Playback is an AI-generated voice. Microphone permission remains optional; typing uses the same planning path.</p></details>' },
        openingStopReadAloud: { type: "button", weight: 191, text: "Stop AI read-aloud", cls: "opening-native-voice-stop", hidden: true, onAction: "up.stopReadAloud" },
        openingCancelRecording: { type: "button", weight: 192, text: "Cancel recording", cls: "opening-native-voice-cancel", hidden: true, onAction: "up.cancelVoice" },
        openingClearDraft: { type: "button", weight: 193, text: "Clear draft", cls: "opening-native-voice-clear", hidden: true, onAction: "up.clearVoiceDraft" },
        openingPlan: { type: "widget", weight: -100, cls: "opening-native-plan", hidden: !plan,
        html: plan ? planningChecklistHtml(plan) : "" } },
    } },
    delayStatusTexts: ["Reading the current production…", "Checking the constraints…", "The original response is still working…"],
  };
  type NativeConfig = Exclude<NonNullable<NonNullable<ConstructorParameters<typeof Gantt>[0]>["features"]>["ai"], boolean | string | undefined>;
  return config as unknown as NativeConfig;
}
