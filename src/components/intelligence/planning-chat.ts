"use client";
import { Widget } from "@bryntum/core-enterprise";
import ChatButton from "@bryntum/core-enterprise/lib/Core/widget/chat/ChatButton.js";
import { ReviewedNativeChatPopup } from "./native-voice";
import { planningPopupBounds } from "./chat-layout";

/** Retains the reviewed native audio, focus, Escape and request behavior. Layout changes make no requests. */
export class ReadablePlanningChatPopup extends ReviewedNativeChatPopup {
  static $name = "OpeningNightReadablePlanningChat";
  static type = "openingnightreadableplanningchat";
  private declare viewportChanged: (() => void) | undefined;
  private declare layoutFrame: number | undefined;
  fitPlanningViewport() {
    if (this.isDestroyed) return;
    const viewport = window.visualViewport, bounds = planningPopupBounds({ width: viewport?.width || window.innerWidth, height: viewport?.height || window.innerHeight, offsetLeft: viewport?.offsetLeft ?? 0, offsetTop: viewport?.offsetTop ?? 0 });
    const { x, y, ...size } = bounds; this.setConfig(size); this.setXY(x, y); this.element.dataset.compactHeight = String(bounds.height < 420);
    const clear = this.widgetMap.openingClearDraft; if (clear) clear.hidden = !this.messageField.value?.trim();
  }
  override async showBy(_alignment: unknown) { this.alignTo(); await this.show(); }
  override async show() {
    this.fitPlanningViewport(); await super.show();
    if (!this.isDestroyed && this.isVisible) {
      this.fitPlanningViewport();
      this.viewportChanged ??= () => { if (this.layoutFrame) cancelAnimationFrame(this.layoutFrame); this.layoutFrame = requestAnimationFrame(() => { this.layoutFrame = undefined; if (this.isVisible) this.fitPlanningViewport(); }); };
      window.addEventListener("resize", this.viewportChanged); window.visualViewport?.addEventListener("resize", this.viewportChanged); window.visualViewport?.addEventListener("scroll", this.viewportChanged);
    }
  }
  override onTextFieldInput(event: Parameters<ReviewedNativeChatPopup["onTextFieldInput"]>[0]) { super.onTextFieldInput(event); const clear = this.widgetMap.openingClearDraft; if (clear) clear.hidden = !event.source.value?.trim(); }
  private stopViewportTracking() { if (this.viewportChanged) { window.removeEventListener("resize", this.viewportChanged); window.visualViewport?.removeEventListener("resize", this.viewportChanged); window.visualViewport?.removeEventListener("scroll", this.viewportChanged); } if (this.layoutFrame) cancelAnimationFrame(this.layoutFrame); this.layoutFrame = undefined; }
  override afterHide(...args: unknown[]) { this.stopViewportTracking(); super.afterHide(...args); }
  override doDestroy() { this.stopViewportTracking(); super.doDestroy(); }
}
ReadablePlanningChatPopup.initClass();

/** The installed mobile ChatButton substitutes a drawer type; keep the reviewed popup at every width. */
export class ReadablePlanningChatButton extends ChatButton {
  static $name = "OpeningNightReadablePlanningButton";
  static type = "openingnightreadableplanningbutton";
  override changeChatPanel(config: Record<string, unknown> | null, old: unknown) {
    const api = Widget as typeof Widget & { reconfigure(old: unknown, config: Record<string, unknown> | null): unknown };
    return api.reconfigure(old, config ? { ...config, type: ReadablePlanningChatPopup.type, owner: this, showCloseButton: true, draggable: false, autoShow: false, showAnimation: false, hideAnimation: false, scrollAction: "realign", internalListeners: { visibilityChange: "up.onVisibilityChange", unreveal: "up.onVisibilityChange", reveal: "up.onVisibilityChange", ...(config.internalListeners as Record<string, unknown> ?? {}) } } : null);
  }
}
ReadablePlanningChatButton.initClass();
