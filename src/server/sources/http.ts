import { DomainError } from "@/domain/contracts";
import { sourceLimits, sourceUploadSchema } from "@/domain/sources";
import { boundedBytes } from "../bounded-body";

export async function sourceUploadBody(request: Request) {
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("multipart/form-data;")) throw new DomainError("SOURCE_MULTIPART_REQUIRED", "Choose one source file and its rights record.", 415);
  const bytes = await boundedBytes(request, sourceLimits.bytes + 32768);
  let form: FormData;
  try { form = await new Response(new Uint8Array(bytes), { headers: { "Content-Type": type } }).formData(); }
  catch { throw new DomainError("SOURCE_MULTIPART_INVALID", "The source upload could not be read.", 400); }
  const entries = [...form.entries()], file = form.get("file"), metadata = form.get("metadata");
  if (entries.length !== 2 || !(file instanceof File) || typeof metadata !== "string" || metadata.length > 10000) throw new DomainError("SOURCE_UPLOAD_SHAPE", "Send exactly one named file with its source metadata.", 400);
  const parsed = sourceUploadSchema.safeParse(JSON.parse(metadata));
  if (!parsed.success) throw new DomainError("SOURCE_RIGHTS_REQUIRED", "Record the source title, purpose and your authority to use this file.", 400);
  return { command: parsed.data, filename: file.name, bytes: Buffer.from(await file.arrayBuffer()) };
}
