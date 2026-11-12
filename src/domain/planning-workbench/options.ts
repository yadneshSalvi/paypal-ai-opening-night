import { z } from "zod";
export const strategyKinds = ["doors_window", "set_length", "quiet_preparation", "stage_soundcheck", "running_order", "crew_substitution"] as const;
export const strategyRequestSchema = z.strictObject({
  kinds: z.array(z.enum(strategyKinds)).min(1).max(6).refine(rows => new Set(rows).size === rows.length),
  offerIds: z.array(z.string().min(1).max(100)).min(1).max(8).refine(rows => new Set(rows).size === rows.length),
  substitutions: z.array(z.strictObject({ taskId: z.string().min(1).max(100), replacesPersonId: z.string().min(1).max(100), personId: z.string().min(1).max(100) })).max(4),
});
export type StrategyRequest = z.infer<typeof strategyRequestSchema>;

export const assignmentMapSchema = z.array(z.strictObject({ callId: z.string().min(1).max(100), taskId: z.string().min(1).max(100) })).min(1).max(100).refine(rows => new Set(rows.map(row => row.callId)).size === rows.length && new Set(rows.map(row => row.taskId)).size === rows.length, "Map each original call and target task once.");
export type AssignmentMap = z.infer<typeof assignmentMapSchema>;
