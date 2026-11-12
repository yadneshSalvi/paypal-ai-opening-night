// Fresh local-only configuration. No parent/runtime capability or fixture file is read.
import './disabled-providers.mjs';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { parse } from 'dotenv';
import { Pool } from 'pg';
if (process.env.VERCEL) throw new Error('Managed supplier QA is local only');
if(existsSync(new URL('../../.env',import.meta.url)))throw new Error('Supplier QA refuses an application environment file');
const configPath = new URL('../../.private/local-only.env', import.meta.url);
if ((statSync(configPath).mode & 0o077) !== 0) throw new Error('Supplier configuration must be owner-only');
const parsed = parse(readFileSync(configPath));
const required = ['DATABASE_URL','JUDGE_SESSION_SECRET','BRYNTUM_LICENSE_KEY','OPENING_NIGHT_SUPPLIER_ADMIN_DATABASE','OPENING_NIGHT_SUPPLIER_ADMIN_ROLE','OPENING_NIGHT_SUPPLIER_ADMIN_PORT'];
const allowed = [...required, 'APP_BASE_URL','OPENING_NIGHT_AI_QA','OPENING_NIGHT_QA_FIXTURE'];
for (const name of Object.keys(parsed)) if (!allowed.includes(name)) throw new Error('Unexpected supplier configuration field');
if(parsed.APP_BASE_URL&&parsed.APP_BASE_URL!=='http://127.0.0.1:4619'||['OPENING_NIGHT_AI_QA','OPENING_NIGHT_QA_FIXTURE'].some(name=>parsed[name]&&parsed[name]!=='1'))throw new Error('Unexpected supplier local origin or guard flag');
for (const name of required) { if (!parsed[name]) throw new Error('Missing dedicated supplier configuration'); process.env[name] = parsed[name]; }
const database = new URL(process.env.DATABASE_URL);
if (!['localhost','127.0.0.1'].includes(database.hostname) || database.port !== process.env.OPENING_NIGHT_SUPPLIER_ADMIN_PORT || database.port !== '55575' || decodeURIComponent(database.pathname.slice(1)) !== process.env.OPENING_NIGHT_SUPPLIER_ADMIN_DATABASE || decodeURIComponent(database.username) !== process.env.OPENING_NIGHT_SUPPLIER_ADMIN_ROLE || !/^opening_supplier_admin_[a-f0-9]{12}$/.test(process.env.OPENING_NIGHT_SUPPLIER_ADMIN_DATABASE) || !/^supplier_admin_app_[a-f0-9]{12}$/.test(process.env.OPENING_NIGHT_SUPPLIER_ADMIN_ROLE) || database.searchParams.has('options')) throw new Error('Dedicated supplier database/role/port binding failed');
const audit = new Pool({connectionString:process.env.DATABASE_URL,max:1});
try {
  const row = (await audit.query('SELECT current_database() AS database,current_user AS role,current_schema() AS schema,inet_server_port() AS port')).rows[0];
  if(row.database!==process.env.OPENING_NIGHT_SUPPLIER_ADMIN_DATABASE||row.role!==process.env.OPENING_NIGHT_SUPPLIER_ADMIN_ROLE||row.schema!=='supplier_admin_runtime'||row.port!==55575)throw new Error('Dedicated supplier database identity/schema binding failed');
} finally { await audit.end(); }
process.env.OPENING_NIGHT_SUPPLIER_ADMIN_QA = '1';
process.env.OPENING_NIGHT_QA_FIXTURE = '';
process.env.APP_BASE_URL = 'http://127.0.0.1:4619';
process.env.SUPPLIER_SERVICE_BASE_URL = 'http://127.0.0.1:4619';
