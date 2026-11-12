import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./inputs.css";
export const metadata: Metadata = { title: "Production inputs — Opening Night", referrer: "no-referrer", robots: { index: false, follow: false } };
export default function InputsLayout({ children }: { children: ReactNode }) { return children; }
