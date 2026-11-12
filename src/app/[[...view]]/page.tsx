import { notFound } from "next/navigation";
import { currentActor, consoleData, isProductionActor } from "@/server/http";
import { getShow } from "@/server/store";
import { env } from "@/server/env";
import { TourConsole } from "@/components/tour/tour-console";
import { PersonalTourConsole } from "@/components/tour/personal-tour";
import { ProductionConsole } from "@/components/production-console";
import { CrewAccess } from "@/components/crew-access";
import { PaymentReturn } from "@/components/payment-return";
import { WalletReturn } from "@/components/wallet-return";
import { SupplierAccess } from "@/components/supplier-access";
import { DeliveryAccess } from "@/components/delivery-access";
export const dynamic = "force-dynamic";
const views = ["show", "plan", "sources", "resources", "calendar", "recovery", "disruptions", "execution", "crew", "box-office", "wrap", "evidence"];
export default async function Page({ params }: { params: Promise<{ view?: string[] }> }) {
  const { view } = await params; const selected = view?.join("/") || "show";
  if (selected === "tour") return <TourConsole licenseKey={env.bryntumLicense} />;
  if (selected === "tour/crew") return <PersonalTourConsole licenseKey={env.bryntumLicense} />;
  if (selected === "crew/access") return <CrewAccess licenseKey={env.bryntumLicense} />;
  if (selected === "payments/return") return <PaymentReturn tenantId={(await currentActor())?.tenantId ?? null} />;
  if (selected === "wallet/return") return <WalletReturn tenantId={(await currentActor())?.tenantId ?? null} />;
  if (selected === "supplier/access") return <SupplierAccess />;
  if (selected === "delivery/access") return <DeliveryAccess />;
  if (!views.includes(selected)) notFound();
  const actor = await currentActor();
  const data = actor && isProductionActor(actor) ? consoleData(await getShow(actor.tenantId), actor) : null;
  return <ProductionConsole initial={data} view={selected} licenseKey={env.bryntumLicense} />;
}
