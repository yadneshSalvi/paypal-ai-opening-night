import { createDisruptionNativeFaults, disruptionFaultModes } from './disruption-native-faults.mjs';
export const supplierAdminFaultModes=[...disruptionFaultModes,'respond-503-before-dispatch'];
export function createSupplierAdminNativeFaults(options){return createDisruptionNativeFaults({...options,commandPath:'/api/supplier-admin/commands',commandIdKey:'commandId',modes:supplierAdminFaultModes});}
