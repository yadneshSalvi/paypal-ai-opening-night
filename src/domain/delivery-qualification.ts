import type { ShowSnapshot } from "./contracts";

/** Select exactly one current qualified assignee; a former named lead gains no access. */
export function currentLightingInspector(show: ShowSnapshot) {
  const task = show.tasks.find(row => row.id === "lx-program");
  if (!task) return undefined;
  const candidates = show.resources.filter(person => {
    if (person.kind !== "person" || person.reserve || !task.resources.includes(person.id) || !person.skills.includes("lx_programming")) return false;
    if (Date.parse(task.start) < Date.parse(person.availableFrom) || Date.parse(task.end) > Date.parse(person.availableUntil)) return false;
    const qualification = show.productionInputs?.roster.find(row => row.personId === person.id)?.qualifications?.find(row => row.skill === "lx_programming");
    return !qualification?.expiresAt || Date.parse(qualification.expiresAt) >= Math.max(Date.parse(task.end), Date.parse(show.clock));
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}
