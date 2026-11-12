import type { Metadata } from "next";
import { SupplierAdminDesk } from "@/components/supplier-admin/manage-desk";
import "../supplier-admin.css";
export const metadata: Metadata = { title: "Supplier owner · Opening Night", robots: { index: false, follow: false }, referrer: "same-origin" };
export default function SupplierOwnerPage() { return <SupplierAdminDesk ownerMode />; }
