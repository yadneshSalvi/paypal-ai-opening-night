import type { Metadata } from "next";
import { AttendeeAccess } from "@/components/audience/attendee";
export const metadata: Metadata = { title: "Your private ticket — Opening Night", robots: { index: false, follow: false }, referrer: "no-referrer" };
/** No production session, generic Actor, database, or browser cookie is needed to render the access shell. */
export default function AttendeePage() { return <AttendeeAccess />; }
