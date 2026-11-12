import type { ConsoleData, Lane } from "@/domain/contracts";
import type { ProductionSelection } from "./model";
export interface StageSelectionNode { id: string; label: string; detail: string; selection: ProductionSelection; affected: boolean }
/** Department anchors are illustrative, not asserted physical coordinates. */
export function stageSelectionNodes(data: ConsoleData): StageSelectionNode[] {
  const { show } = data, lanes: Lane[] = ["lighting", "audio", "stage", "house", "people", "commercial"];
  const nodes: StageSelectionNode[] = [];
  for (const lane of lanes) {
    const tasks = show.tasks.filter(row => row.lane === lane && !row.cancellation);
    const task = tasks.find(row => row.affected && row.critical) ?? tasks.find(row => row.critical) ?? tasks[0];
    if (task) nodes.push({ id: "lane:" + lane, label: lane.toUpperCase(), detail: task.name, selection: { kind: "task", id: task.id }, affected: task.affected });
  }
  for (const resource of show.resources.filter(row => row.kind === "equipment" && row.critical).slice(0, 6)) nodes.push({ id: "resource:" + resource.id, label: resource.name, detail: "Equipment source & linked calls", selection: { kind: "resource", id: resource.id }, affected: show.incidents.some(row => row.confirmed && row.resourceIds.includes(resource.id)) });
  return nodes;
}
