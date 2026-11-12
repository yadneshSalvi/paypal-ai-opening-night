import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./consents.css";
export const metadata: Metadata = { title: "Separate artist consent — Opening Night", referrer: "no-referrer", robots: { index: false, follow: false } };
export default function ApprovalLayout({ children }: { children: ReactNode }) { return children; }
