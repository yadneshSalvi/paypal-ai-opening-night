import { createHash, timingSafeEqual } from "node:crypto";
import { DomainError } from "@/domain/contracts";
import "./env";
export function authorizeWorker(request: Request) {
  const configured = process.env.CRON_SECRET;
  if (!configured || configured.length < 32) throw new DomainError("WORKER_NOT_CONFIGURED", "The durable worker has not been enabled for this deployment.", 503);
  const supplied = request.headers.get("authorization") ?? "";
  const hash = (value: string) => createHash("sha256").update(value).digest();
  if (supplied.length > 512 || !timingSafeEqual(hash(supplied), hash("Bearer " + configured))) throw new DomainError("WORKER_AUTH_REQUIRED", "This endpoint requires the configured worker capability.", 401);
}
