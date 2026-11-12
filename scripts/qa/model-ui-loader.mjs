// Component-state tests only. Native timeline/audio rendering is a separate root gate.
const canvas = new URL('../../src/components/production-canvas.tsx', import.meta.url).href;
const voice = new URL('../../src/components/intelligence/voice-record.tsx', import.meta.url).href;
export async function load(url, context, nextLoad) {
  if (url === canvas) return { format: 'module', shortCircuit: true, source: 'export function ProductionCanvas(props) { globalThis.openingNightMountedPlanningOptions = props.assistant ?? null; return null; }' };
  if (url === voice) return { format: 'module', shortCircuit: true, source: 'export function VoiceRecord() { return null; }' };
  return nextLoad(url, context);
}
