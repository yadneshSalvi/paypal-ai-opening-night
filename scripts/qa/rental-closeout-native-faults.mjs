/** Same bounded transport harness, scoped to original rental command identities. */
import { createDisruptionNativeFaults, disruptionFaultModes } from './disruption-native-faults.mjs';
export const rentalCloseoutFaultModes = [...disruptionFaultModes, 'respond-503-before-dispatch'];
export function createRentalCloseoutNativeFaults(options) {
  return createDisruptionNativeFaults({ ...options, commandPath: '/api/rental-closeout/commands', commandIdKey: 'commandId', modes: rentalCloseoutFaultModes });
}
