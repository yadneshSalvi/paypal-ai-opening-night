/** Fresh-process GET-only recovery for an explicitly owned isolated test schema. */
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { z } from "zod";
import { digest } from "../../src/domain/hash";

const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
if (process.cwd() !== root || process.env.OPENING_NIGHT_AUDIENCE_QA !== "1") throw new Error("Exact isolated audience recovery runtime required");
const input = process.argv[2];
if (!input || !/^\.artifacts\/audience-stage17\/process-[a-zA-Z0-9_-]+\/input\.json$/.test(input)) throw new Error("A private bounded audience test input is required");
const filename = path.join(root, input), stat = await lstat(filename);
if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 12000 || stat.mode & 0o077 || await realpath(filename) !== filename) throw new Error("The private audience test input is not qualified");
const value = z.object({ schema: z.string().regex(/^on_test_[a-f0-9]{32}$/), producerToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/), attendeeToken: z.string().regex(/^att_[A-Za-z0-9_-]{43}$/), tenantId: z.uuid(), commandId: z.uuid(), draftId: z.uuid() }).strict().parse(JSON.parse(await readFile(filename, "utf8")));
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("Owned database required");
const pool = new Pool({ connectionString, options: "-c search_path=" + value.schema, max: 2 });
(globalThis as typeof globalThis & { openingNightPool?: Pool }).openingNightPool = pool;
try {
  if ((await pool.query("SELECT current_schema() AS schema")).rows[0]?.schema !== value.schema) throw new Error("Recovery schema scope failed");
  const command = await import("../../src/app/api/audience/commands/[id]/route"), invitation = await import("../../src/app/api/audience/invites/[id]/route"), message = await import("../../src/app/api/audience/messages/[id]/route"), attendee = await import("../../src/app/api/attendee/route");
  const request = (token: string, endpoint: string) => new Request("http://127.0.0.1:4594" + endpoint, { headers: { authorization: "Bearer " + token, "x-opening-night-production": value.tenantId } });
  const recovered = await command.GET(request(value.producerToken, "/api/audience/commands/" + value.commandId), { params: Promise.resolve({ id: value.commandId }) });
  if (recovered.status !== 200) throw new Error("The original command was not readable in this fresh process");
  const original = await recovered.json();
  if (original.receipt.action !== "create_invite" || !original.invitation) throw new Error("Original invitation receipt required");
  const link = await invitation.GET(request(value.producerToken, "/api/audience/invites/" + original.invitation.capabilityId), { params: Promise.resolve({ id: original.invitation.capabilityId }) });
  const preview = await message.GET(request(value.producerToken, "/api/audience/messages/" + value.draftId), { params: Promise.resolve({ id: value.draftId }) });
  const inbox = await attendee.GET(request(value.attendeeToken, "/api/attendee"));
  if ([link, preview, inbox].some(response => response.status !== 200)) throw new Error("An exact original audience record was not readable");
  const [savedLink, savedMessage, savedInbox] = await Promise.all([link.json(), preview.json(), inbox.json()]);
  // Output only non-authorizing hashes and measurements; no token, URL, Actor or ticket data.
  console.log(JSON.stringify({ version: 1, requests: 4, mutations: 0, commandDigest: digest(original.receipt), invitationDigest: digest(savedLink), draftDigest: digest(savedMessage.draft), deliveryDigests: savedMessage.deliveries.map((item: { digest: string }) => item.digest), inboxDigests: savedInbox.inbox.map((item: { digest: string }) => item.digest), originalExpiryDigest: digest(savedLink.expiresAt), replayed: original.replayed }));
} finally { await pool.end(); }
