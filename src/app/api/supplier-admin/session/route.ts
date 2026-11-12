import { cookies } from "next/headers";
import { DomainError } from "@/domain/contracts";
import { assertSameOrigin } from "@/server/http";
import { adminAuthority, adminError, adminJson, SUPPLIER_ADMIN_COOKIE } from "@/server/supplier-admin/http";
import { requireAdminAuthority } from "@/server/supplier-admin/store";
import { pool } from "@/server/store";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); const authorization = request.headers.get("authorization");
    if (!authorization || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) throw new DomainError("SUPPLIER_INVITATION_REQUIRED", "Open the supplier's original private invitation.", 401);
    const authority = await adminAuthority(request), expiresAt = await requireAdminAuthority(pool, authority, undefined, "supplier");
    (await cookies()).set(SUPPLIER_ADMIN_COOKIE, authorization.slice(7), { httpOnly: true, secure: new URL(request.url).protocol === "https:", sameSite: "strict", path: "/api/supplier-admin", expires: new Date(expiresAt) });
    return adminJson({ connected: true, expiresAt, message: "Original supplier access connected. Its fixed expiry is unchanged." });
  } catch (error) { return adminError(error); }
}
