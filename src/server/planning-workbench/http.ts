import { DomainError } from '@/domain/contracts';
import { planningJson, planningError } from '../intelligence/http';
export function workbenchUrl(request:Request){if(new URL(request.url).search)throw new DomainError('WORKBENCH_QUERY_INVALID','This endpoint accepts no query capabilities or alternate command path.',400);}
export function workbenchJson(value:unknown){const response=planningJson(value);response.headers.set('Referrer-Policy','no-referrer');return response;}
export function workbenchError(error:unknown){const response=planningError(error);response.headers.set('Referrer-Policy','no-referrer');return response;}
