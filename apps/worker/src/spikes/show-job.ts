// Spike A: print a pg-boss job row straight from pgboss.job (no pg-boss code in the read path).
import { loadEnv } from "@repo/core";
import { loadRootEnvFile } from "@repo/core/dotenv";
import { createPgPool } from "@repo/db";

loadRootEnvFile();
const { DATABASE_URL } = loadEnv(["database"]);
const [id] = process.argv.slice(2);
if (!id) {
  console.error("usage: show-job <job id>");
  process.exit(2);
}
const pool = createPgPool(DATABASE_URL, { max: 1, applicationName: "spike-show-job" });
const { rows } = await pool.query(
  `SELECT id, name, state, retry_count, retry_limit, expire_seconds,
          to_char(started_on, 'HH24:MI:SS.MS') AS started_on,
          to_char(completed_on, 'HH24:MI:SS.MS') AS completed_on,
          to_char(now(), 'HH24:MI:SS.MS') AS db_now,
          output
     FROM pgboss.job WHERE id = $1`,
  [id],
);
console.log(JSON.stringify(rows[0] ?? { id, found: false }));
await pool.end();
