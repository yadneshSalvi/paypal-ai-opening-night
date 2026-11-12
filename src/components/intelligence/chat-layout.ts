import { escapeMessageText } from "./safe-message";
export interface PlanningViewport { width: number; height: number; offsetLeft?: number; offsetTop?: number }
/** Numeric SDK bounds avoid native CSS-size parsing, anchor clipping and retained height animations. */
export function planningPopupBounds(viewport: PlanningViewport) {
  const width = Number.isFinite(viewport.width) && viewport.width > 0 ? viewport.width : 320, height = Number.isFinite(viewport.height) && viewport.height > 0 ? viewport.height : 568;
  const padding = Math.min(12, width / 8, height / 8), availableWidth = Math.max(1, width - padding * 2), availableHeight = Math.max(1, height - padding * 2);
  const panelWidth = Math.min(620, availableWidth), panelHeight = Math.min(760, availableHeight);
  return { width: panelWidth, height: panelHeight, minHeight: Math.min(320, availableHeight), maxHeight: availableHeight, maxWidth: availableWidth, x: (Number.isFinite(viewport.offsetLeft) ? viewport.offsetLeft! : 0) + (width - panelWidth) / 2, y: (Number.isFinite(viewport.offsetTop) ? viewport.offsetTop! : 0) + (height - panelHeight) / 2 };
}
export interface PresentedPlan { goal?: string; steps: readonly { id: number; description: string; completed: boolean }[] }
export function planningChecklistHtml(plan: PresentedPlan, open = false) {
  const completed = plan.steps.filter(step => step.completed).length, pending = plan.steps.length - completed;
  return '<details class="opening-planning-checklist"' + (open ? " open" : "") + '><summary><span>Planning checklist</span><strong>' + completed + "/" + plan.steps.length + ' saved</strong><small>' + pending + ' pending · not approval</small></summary><div class="opening-planning-checklist-body"><p>' + escapeMessageText(plan.goal ?? "Current planning goal") + '</p><ol>' + plan.steps.map(step => '<li data-complete="' + Boolean(step.completed) + '"><b aria-hidden="true">' + (step.completed ? "✓" : escapeMessageText(String(step.id))) + '</b><span>' + escapeMessageText(step.description === "Prepare a reviewed alternative" ? "Prepare an alternative for review" : step.description) + '<small>' + (step.completed ? "Saved tool evidence" : "Pending") + "</small></span></li>").join("") + '</ol><p>Checklist completion records planning evidence. It never grants approval, assigns crew or changes active calls.</p></div></details>';
}
