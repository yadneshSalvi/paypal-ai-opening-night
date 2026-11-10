import type { Dependency, Lane, Resource, ShowSnapshot, Task } from "./contracts";
import { atVenue, atZone, plusMinutes } from "./time";
import { digest } from "./hash";

const person = (id: string, name: string, role: string, department: Lane, skills: string[], color: string, reserve = false): Resource => ({
  id, name, role, initials: name.split(" ").map(word => word[0]).join(""), kind: "person", department, skills,
  critical: !reserve, reserve, color, availableFrom: atVenue("10:00"), availableUntil: atVenue("00:45", "2026-11-15"), rateMinor: 3500,
});
export const CREW = [
  person("sam", "Sam Rivera", "Stage manager", "stage", ["stage_management", "show_control"], "#e6aa57"),
  person("priya", "Priya Shah", "Lighting programmer", "lighting", ["lx_programming", "lx_focus", "rigging"], "#e7bb68"),
  person("tom", "Tom Chen", "Lighting technician", "lighting", ["lx_focus", "electrical"], "#8ab1c5"),
  person("dana", "Dana Cole", "FOH sound engineer", "audio", ["audio_foh", "quiet_prep"], "#c6a5dd"),
  person("lee", "Lee Park", "Monitor engineer", "audio", ["audio_monitors"], "#b5abdc"),
  person("alex", "Alex Moreno", "Head rigger", "stage", ["rigging"], "#a2b9aa"),
  person("robin", "Robin Ellis", "Rigger", "stage", ["rigging"], "#83a79c"),
  person("morgan", "Morgan Vale", "Stagehand", "stage", ["stagehand"], "#ad9a81"),
  person("casey", "Casey Stone", "Stagehand", "stage", ["stagehand"], "#b3a487"),
  person("jules", "Jules Reed", "Stagehand", "stage", ["stagehand"], "#b99c8a"),
  person("avery", "Avery Moss", "Front of house manager", "house", ["house_management"], "#96baaa"),
  person("rory", "Rory Lane", "Reserve stagehand", "stage", ["stagehand"], "#7f8688", true),
];

function task(id: string, name: string, lane: Lane, start: string, duration: number, resources: string[], options: Partial<Task> = {}): Task {
  const instant = atVenue(start);
  return { id, name, lane, start: instant, end: plusMinutes(instant, duration), durationMinutes: duration,
    baselineStart: instant, baselineEnd: plusMinutes(instant, duration), resources, requiredSkill: null,
    state: "planned", critical: true, affected: false, milestone: null, sourceId: "rider-v1", ...options };
}
const edge = (from: string, to: string, financial = false, lagMinutes = 0): Dependency => ({ id: `${from}:${to}`, from, to, financial, lagMinutes });

export function createFixture(tenantId: string, now = new Date().toISOString()): ShowSnapshot {
  const tasks: Task[] = [
    task("load-in", "Venue load-in & rigging", "stage", "10:00", 90, ["alex", "robin", "morgan", "casey", "jules"]),
    task("hang", "Lighting hang & patch", "lighting", "11:30", 90, ["priya", "tom"], { requiredSkill: "lx_focus" }),
    task("audio-rig", "PA deployment & alignment", "audio", "11:30", 80, ["dana", "lee"]),
    task("meal", "Crew meal break", "people", "14:00", 45, CREW.filter(r => r.critical).map(r => r.id)),
    task("support-check", "Juniper Lane soundcheck", "audio", "14:45", 40, ["dana", "lee"]),
    task("console-test", "Console self-test", "lighting", "15:15", 10, ["priya", "tom"], { milestone: "console_test" }),
    task("lx-focus", "LX focus", "lighting", "15:30", 45, ["priya", "tom"], { requiredSkill: "lx_focus" }),
    task("lx-program", "LX programming & cue validation", "lighting", "16:15", 20, ["priya"], { requiredSkill: "lx_programming" }),
    task("headliner-arrival", "Headliner on site", "people", "15:55", 0, [], { milestone: "headliner_checkin" }),
    task("headliner-check", "Headliner soundcheck", "audio", "16:15", 60, ["dana", "lee"]),
    task("vip", "VIP soundcheck visit", "house", "17:30", 30, ["avery"]),
    task("house-check", "FOH & venue safety checks", "house", "18:15", 20, ["avery"]),
    task("readiness", "DOORS readiness check", "stage", "18:45", 0, ["sam"], { milestone: "doors_readiness" }),
    task("doors", "DOORS · house open", "house", "19:00", 0, ["avery"], { milestone: "doors" }),
    task("support", "Juniper Lane", "stage", "20:00", 25, ["sam", "dana", "lee"]),
    task("changeover", "Stage changeover", "stage", "20:25", 15, ["morgan", "casey", "jules"]),
    task("headliner", "The Night Ferries", "stage", "20:45", 90, ["sam", "dana", "lee"]),
    task("strike", "Quiet strike & return", "stage", "22:15", 75, ["sam", "priya", "tom", "alex", "robin", "morgan", "casey", "jules"]),
  ];
  const checks: [string, Lane, string, string[]][] = [
    ["Rigging", "stage", "alex", ["Inspect points", "Review lift plan", "Mark exclusion zone", "Check motors", "Inspect slings", "Verify safeties", "Sign rigging sheet", "Clear deck"]],
    ["Lighting", "lighting", "tom", ["Inspect power", "Label circuits", "Check dimmers", "Map universe", "Verify data path", "Address fixtures", "Test fixtures", "Check isolation"]],
    ["Audio", "audio", "lee", ["Check cable stock", "Line inventory", "Label stagebox", "Ring monitors", "Check RF scan", "Set talkback", "Verify spare mic", "Test comms"]],
    ["House", "house", "avery", ["Inspect exits", "Check signage", "Box office brief", "Test scanners", "Stock water", "Accessibility route", "VIP list check", "Brief stewards"]],
    ["Production", "people", "sam", ["Confirm rider", "Venue handover", "Supplier check-in", "Crew call", "Review curfew", "Approve access", "Emergency briefing", "Issue radio channels"]],
    ["Stage", "stage", "morgan", ["Measure deck", "Mark stage plan", "Check risers", "Load backline", "Check drum riser", "Place stands", "Mark changeover", "Secure cases"]],
    ["Patch", "lighting", "priya", ["Load show file", "Verify patch", "Review focus notes", "Test playback", "Prepare presets", "Back up cues", "Check worklights", "Review power plan"]],
    ["Sound", "audio", "dana", ["Load scene", "Review inputs", "Check matrix", "Verify playback", "Calibrate outputs", "Check SPL policy", "Review quiet prep", "Print input list"]],
  ];
  for (const [group, lane, resource, names] of checks) names.forEach((name, index) => {
    const start = plusMinutes(atVenue("10:00"), index * 10);
    tasks.push(task(`${group.toLowerCase()}-check-${index}`, `${group} · ${name}`, lane, "10:00", 10, [resource], {
      start, end: plusMinutes(start, 10), baselineStart: start, baselineEnd: plusMinutes(start, 10), critical: false, state: "complete",
    }));
  });
  const dependencies = [edge("load-in", "hang"), edge("hang", "console-test"), edge("console-test", "lx-focus"), edge("lx-focus", "lx-program"), edge("lx-program", "readiness"), edge("headliner-arrival", "headliner-check"), edge("headliner-check", "vip"), edge("house-check", "readiness"), edge("readiness", "doors"), edge("doors", "support"), edge("support", "changeover"), edge("changeover", "headliner"), edge("headliner", "strike")];
  const source = (id: string, title: string, detail: string) => ({ id, title, detail, source: "sample" as const, recordedAt: now });
  const sheet = { id: `${tenantId}:sheet:1`, version: 1, planRevision: 1, candidateId: null, digest: digest(tasks), publishedAt: now, tasks: structuredClone(tasks), changes: [] };
  return {
    schemaVersion: 1, id: "alder-hall", tenantId, revision: 1, planVersion: 1, title: "The Night Ferries", support: "Juniper Lane", venue: "Alder Hall", zone: "America/Chicago", showDate: "2026-11-14", clock: atVenue("15:25"), createdAt: now, updatedAt: now,
    doorsAt: atVenue("19:00"), curfewAt: atVenue("23:00"), accessUntil: atVenue("00:45", "2026-11-15"), nextCallAt: atVenue("10:00", "2026-11-15"),
    state: "standby", policy: { version: 1, minimumRestMinutes: 600, maxShiftMinutes: 720, refundCount: 38, criticalCrewCount: 11 },
    tasks, dependencies, resources: [...CREW, { id: "console", name: "LX console", role: "Lighting control", initials: "LX", kind: "equipment", department: "lighting", skills: [], critical: true, reserve: false, color: "#ffb000", availableFrom: atVenue("10:00"), availableUntil: atVenue("23:30"), rateMinor: 0 }, { id: "backstage", name: "Isolated backstage room", role: "Quiet artist preparation", initials: "BS", kind: "space", department: "audio", skills: [], critical: false, reserve: false, color: "#c6a5dd", availableFrom: atVenue("19:35"), availableUntil: atVenue("20:40"), rateMinor: 0 }],
    offers: [
      { id: "offer-brightline-1", supplierId: "brightline", supplier: "Brightline Rentals", initials: "BR", unitId: "brightline-console-a", revision: 1, feeMinor: 48000, depositMinor: 30000, deliveryAt: atVenue("17:15"), expiresAt: atVenue("16:45"), compatible: true, qualifiedDriver: true, conditionVerified: true, terms: "Delivery and return included. $300 damage hold; inspection before closure.", source: "sample", status: "quoted" },
      { id: "offer-northside-1", supplierId: "northside", supplier: "Northside AV", initials: "NA", unitId: "northside-console-a", revision: 1, feeMinor: 33000, depositMinor: 30000, deliveryAt: atVenue("18:40"), expiresAt: atVenue("17:00"), compatible: true, qualifiedDriver: true, conditionVerified: true, terms: "Later delivery window. Compatible desk; qualified operator handover.", source: "sample", status: "quoted" },
      { id: "offer-sister-1", supplierId: "sister", supplier: "The sister venue", initials: "SV", unitId: "sister-console-a", revision: 1, feeMinor: 0, depositMinor: 0, deliveryAt: atVenue("16:50"), expiresAt: atVenue("17:00"), compatible: true, qualifiedDriver: null, conditionVerified: null, terms: "Collection only. Qualified driver and equipment condition still unconfirmed.", source: "sample", status: "quoted" },
    ], incidents: [], runs: [], approvedPlan: null, sheets: [sheet], acknowledgments: [], financialEvidence: [], tickets: [], facts: [],
    sources: [source("rider-v1", "Alder Hall production rider · v1", "Owned fictional source. Original soundcheck 16:15–17:15; VIP visit 17:30–18:00; music 20:00."), source("venue-policy-v1", "Venue operating policy · v1", "Hard 23:00 performance/amplified-audio curfew. Approved quiet access until 00:45. Fixture policy, not universal law."), source("crew-policy-v1", "Crew call & rest policy · v1", "Sam and Priya have a Sunday 10:00 matinee call. At least 10 hours between calls."), source("ticket-policy-v1", "Ticket remedy policy · v1", "Target cohort: 42 standard $35, 38 VIP $35+$15. Canceling the soundcheck perk permits a $15 original-capture refund. No captures created by this fixture."), source("flight-final", "Flight update · final revision", "Rolling ground hold since 12:15 Denver. At 15:10 Chicago, aircraft swap revises departure to 15:55 Denver, landing 18:55 Chicago, transfer 40 minutes."), source("console-report", "Lighting console self-test report", "Controlled demonstration report at 15:25 Chicago. Department lead confirmation required; no physical equipment work claimed.")],
    events: [{ id: `${tenantId}:created`, type: "show.created", message: "Alder Hall rehearsal opened with an approved baseline.", at: now, fixtureAt: atVenue("10:00"), actorId: "system", source: "sample", revision: 1 }], goReportId: null,
  };
}
export function flightIncident() {
  return { id: "flight-delay", kind: "flight" as const, title: "Headliner arrival slips to 19:35", summary: "A 3h40 delay cancels the original soundcheck window. Doors is still a decision.", receivedAt: atVenue("15:10"), sourceZone: "America/Denver", sourceText: "DEN → ORD · departs 15:55 MST · lands 18:55 CST · 40 min transfer", earliestAvailable: plusMinutes(atVenue("18:55"), 40), resourceIds: ["headliner"], affectedTaskIds: ["headliner-arrival", "headliner-check", "vip"], confirmed: true, source: "sample" as const };
}
export function consoleIncident() {
  return { id: "console-failure", kind: "console" as const, title: "LX console failed self-test", summary: "Focus and cue programming need a compatible replacement desk.", receivedAt: atVenue("15:25"), sourceZone: "America/Chicago", sourceText: "Lighting department · confirmed demonstration self-test failure", earliestAvailable: atVenue("17:15"), resourceIds: ["console"], affectedTaskIds: ["console-test", "lx-focus", "lx-program", "readiness", "doors"], confirmed: true, source: "sample" as const };
}
export const FLIGHT_TIMES = { scheduledDeparture: atZone("2026-11-14", "12:15", "America/Denver"), revisedDeparture: atZone("2026-11-14", "15:55", "America/Denver"), landing: atVenue("18:55"), onSite: atVenue("19:35") };
