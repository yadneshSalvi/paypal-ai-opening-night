// Narrow declarations for inspected, pinned Enterprise 8.0.0 experimental hooks.
declare module "@bryntum/gantt-enterprise/lib/Gantt/feature/ai/agents/DefaultGanttAgent.js" {
  export interface NativeToolInput { args: unknown; toolCall?: { id: string }; promptContext?: Record<string, unknown> }
  export interface NativeTool { fn: (input: NativeToolInput) => unknown; [key: string]: unknown }
  export default class DefaultGanttAgent {
    constructor(config: Record<string, unknown>);
    static $name: string;
    get agentTools(): Record<string, NativeTool>;
    beforePost?: (body: Record<string, unknown>) => void;
    client: { features: { ai: { chatPanel?: { widgetMap: { openingPlan?: { html: string; hidden: boolean } } } } } };
    $plan?: { goal?: string; steps: { id: number; description: string; completed: boolean }[] };
    processResponse(response: unknown, context: Record<string, unknown>): Promise<unknown>;
  }
}
declare module "@bryntum/gantt-enterprise/lib/Gantt/feature/ai/toolhosts/GanttToolHost.js" {
  import type { NativeTool } from "@bryntum/gantt-enterprise/lib/Gantt/feature/ai/agents/DefaultGanttAgent.js";
  export default class GanttToolHost {
    constructor(config: Record<string, unknown>);
    static $name: string;
    _configuredTools: Record<string, NativeTool>;
    get tools(): Record<string, NativeTool>;
  }
}
