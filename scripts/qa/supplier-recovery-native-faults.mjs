/** Qualified one-shot transport harness, bound to the reviewed supplier instruction contract. */
import { createDisruptionNativeFaults } from './disruption-native-faults.mjs';
import { rentalCloseoutFaultModes } from './rental-closeout-native-faults.mjs';
export const supplierRecoveryFaultModes = rentalCloseoutFaultModes;
export function createSupplierRecoveryNativeFaults(options) {
  return createDisruptionNativeFaults({ ...options, commandPath: '/api/supplier-recovery/commands', commandIdKey: 'commandId', modes: supplierRecoveryFaultModes });
}
