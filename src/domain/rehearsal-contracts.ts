export interface RehearsalSummary {
  tenantId: string; label: string; title: string; venue: string; revision: number; planVersion: number;
  state: "standby" | "go" | "house_open"; createdAt: string; lastOpenedAt: string; accessExpiresAt: string;
  current: boolean; accessExpired: boolean; hasFinancialHistory: boolean; pendingWork: number; reviewWork: number;
}
export interface RehearsalOverview {
  currentTenantId: string; items: RehearsalSummary[]; total: number; nextOffset: number | null;
  serverAt: string;
}
/** Browser scope is an additional match against the authenticated actor, never independent authority. */
export const PRODUCTION_SCOPE_HEADER = "X-Opening-Night-Production";
