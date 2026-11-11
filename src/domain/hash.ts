import { createHash } from "node:crypto";
import { canonical } from "./canonical";
export { canonical } from "./canonical";
export function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
