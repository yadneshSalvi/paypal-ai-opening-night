import { assertSameOrigin } from "@/server/http";
import { planningAuthority } from "@/server/intelligence/http";
import { inputBody, inputError, inputJson, inputQuery } from "@/server/production-inputs/http";
import { executeProductionInput, productionInputWorkspace, readProductionInputCommand } from "@/server/production-inputs/service";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { const id = inputQuery(request), authority = await planningAuthority(request); return inputJson(id ? await readProductionInputCommand(authority, id) : await productionInputWorkspace(authority)); }
  catch (error) { return inputError(error); }
}
export async function POST(request: Request) {
  try { assertSameOrigin(request); return inputJson(await executeProductionInput(await planningAuthority(request), await inputBody(request))); }
  catch (error) { return inputError(error); }
}
