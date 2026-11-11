import { DomainError } from "@/domain/contracts";

type Configuration = Record<string, string | undefined>;
const directNames = ["DATABASE_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING", "DIRECT_URL"] as const;
function invalid() { return new DomainError("COMMERCE_LOCK_CONFIGURATION", "Commerce work requires a direct PostgreSQL connection to the same database. Configure DATABASE_URL_UNPOOLED before continuing.", 503); }
function parse(value: string | undefined) {
  try { const url = new URL(value ?? ""); if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) throw invalid(); return url; }
  catch { throw invalid(); }
}
function pooled(url: URL) {
  return /(?:^|[.-])(?:pooler|pgbouncer)(?:[.-]|$)/i.test(url.hostname) || ["6432", "6543"].includes(url.port)
    || [...url.searchParams].some(([name, value]) => /^(?:pgbouncer|pooling|pool_mode)$/i.test(name) && !/^(?:false|0|off)$/i.test(value));
}
const local = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
const neon = (url: URL) => url.hostname.endsWith(".neon.tech");
/** Explicit direct credentials only; never rewrite a pooler hostname or inherit a pooled Pool's options. */
export function commerceLockDatabaseUrl(configuration: Configuration): string {
  const primary = parse(configuration.DATABASE_URL);
  const configured = directNames.map(name => configuration[name]?.trim()).find(Boolean);
  const value = configured ?? (local(primary) || neon(primary) && !pooled(primary) ? configuration.DATABASE_URL : undefined);
  const direct = parse(value);
  if (pooled(direct) || direct.pathname !== primary.pathname || direct.username !== primary.username
    || [...direct.searchParams.keys()].some(name => /^(?:host|hostaddr|port|user|database|dbname)$/i.test(name))) throw invalid();
  if (neon(primary) && direct.hostname !== primary.hostname.replace(/-pooler(?=\.)/, "")) throw invalid();
  return value!;
}
