import "./disabled-providers.mjs";
// The caller supplies only this successor's restricted local configuration.
// Never discover or copy another lane's environment or original provider DB.
const database = new URL(process.env.DATABASE_URL ?? "");
if (database.hostname !== "127.0.0.1" || database.port !== "55575" || !/^\/opening_terms_[a-f0-9]{12}$/.test(database.pathname)) throw new Error("Invoice response tests require the owned stage16 PG55575 database");
database.searchParams.delete("options");
for (const key of ["DATABASE_URL", "DATABASE_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING", "DIRECT_URL"]) process.env[key] = database.href;
