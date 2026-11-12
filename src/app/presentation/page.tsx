import { ProductionConsole } from "@/components/production-console";
import { currentActor, consoleData, isProductionActor } from "@/server/http";
import { getShow } from "@/server/store";
import { env } from "@/server/env";
export const dynamic = "force-dynamic";
/** Uses ordinary product authority; visiting this page never creates a production or issues a cue. */
export default async function PresentationPage() {
  const actor = await currentActor();
  const data = actor && isProductionActor(actor) ? consoleData(await getShow(actor.tenantId), actor) : null;
  return <ProductionConsole initial={data} view="presentation" licenseKey={env.bryntumLicense} />;
}
