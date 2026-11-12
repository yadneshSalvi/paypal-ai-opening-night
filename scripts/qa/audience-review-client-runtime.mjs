// Qualification client may reach only the manifest-verified HTTP fixture on4594.
if (process.env.OPENING_NIGHT_AUDIENCE_REVIEW_CLIENT && process.env.OPENING_NIGHT_AUDIENCE_REVIEW_CLIENT !== "http") throw new Error("The audience lifecycle client requires its separate HTTP fixture");
process.env.OPENING_NIGHT_AUDIENCE_REVIEW_CLIENT = "http";
await import("./audience-disabled-runtime.mjs");
