import { notFound } from "next/navigation";
import { currentActor, consoleData } from "@/server/http";
import { getShow } from "@/server/store";
import { env } from "@/server/env";
import { ProductionConsole } from "@/components/production-console";
import { CrewAccess } from "@/components/crew-access";
import { PaymentReturn } from "@/components/payment-return";
import { SupplierAccess } from "@/components/supplier-access";
import { DeliveryAccess } from "@/components/delivery-access";
export const dynamic = "force-dynamic";
const views = ["show", "plan", "resources", "calendar", "recovery", "execution", "crew", "box-office", "wrap", "evidence"];
export default async function Page({ params }: { params: Promise<{ view?: string[] }> }) {
  const { view } = await params; const selected = view?.join("/") || "show";
  if (selected === "crew/access") return <CrewAccess />;
  if (selected === "payments/return") return <PaymentReturn />;
  if (selected === "supplier/access") return <SupplierAccess />;
  if (selected === "delivery/access") return <DeliveryAccess />;
  if (!views.includes(selected)) notFound();
  const actor = await currentActor();
  const data = actor ? consoleData(await getShow(actor.tenantId), actor) : null;
  return <ProductionConsole initial={data} view={selected} licenseKey={env.bryntumLicense} />;
}
