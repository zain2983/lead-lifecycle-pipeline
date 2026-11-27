import { loadEnv } from "@repo/core";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Each test runs in a transaction that is rolled back, so nothing is left in the database.

let pool: pg.Pool;
let client: pg.PoolClient;

beforeAll(() => {
  pool = new pg.Pool({ connectionString: loadEnv(["database"]).DATABASE_URL, max: 1 });
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  client = await pool.connect();
  await client.query("BEGIN");
  return async () => {
    await client.query("ROLLBACK");
    client.release();
  };
});

/** Run `sql` inside a savepoint and return the violated constraint's name (or null if it succeeded). */
async function violation(sql: string, params: unknown[] = []): Promise<string | null> {
  await client.query("SAVEPOINT attempt");
  try {
    await client.query(sql, params);
    await client.query("RELEASE SAVEPOINT attempt");
    return null;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT attempt");
    return (error as { constraint?: string }).constraint ?? (error as Error).message;
  }
}

const insertLead = `INSERT INTO lead (source, email, submitted_at, submitted_time_zone, submitted_at_local)
  VALUES ('hubspot_direct', $1, now(), 'Asia/Karachi', '2026-11-03T14:05:00+05:00') RETURNING id`;

async function lead(email = "ayesha.khan@example.com"): Promise<string> {
  const { rows } = await client.query<{ id: string }>(insertLead, [email]);
  const id = rows[0]?.id;
  if (!id) throw new Error("no lead id");
  return id;
}

async function agentRun(leadId: string, mode = "propose", runId = "triage_test_0001") {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO agent_run (lead_id, workflow_id, workflow_version, mode, proposal_run_id, input_hash)
     VALUES ($1, 'wf_test', 1, $2, $3, 'hash') RETURNING id`,
    [leadId, mode, runId],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("no agent run id");
  return id;
}

describe("lead", () => {
  it("defaults its id and timestamps in the database (raw SQL inserts need no Prisma)", async () => {
    const { rows } = await client.query(
      "SELECT id, created_at, updated_at FROM lead WHERE id = $1",
      [await lead()],
    );
    expect(rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0]?.updated_at).toBeInstanceOf(Date);
  });

  it("accepts reserved email domains only", async () => {
    for (const email of [
      "a@example.com",
      "a@example.org",
      "a@mail.example.net",
      "a@quillmark.test",
      "qa+1@ops.harborlight.test",
    ]) {
      expect(await violation(insertLead, [email]), email).toBeNull();
    }
    for (const email of ["a@example.co", "a@notexample.com", "a@quillmark.invalid", "a@test"]) {
      expect(await violation(insertLead, [email]), email).toBe("lead_email_reserved_domain");
    }
  });

  it("rejects a mixed-case email", async () => {
    expect(await violation(insertLead, ["Ayesha@example.com"])).toBe("lead_email_lowercase");
  });

  it("requires a browser event ID on web-form leads", async () => {
    expect(
      await violation(
        `INSERT INTO lead (source, email, submitted_at, submitted_time_zone, submitted_at_local)
         VALUES ('web_form', 'a@example.com', now(), 'Asia/Karachi', '2026-11-03T14:05:00+05:00')`,
      ),
    ).toBe("lead_web_form_has_event_id");
  });

  it("keeps a purged lead only without its PII", async () => {
    const id = await lead();
    expect(await violation("UPDATE lead SET pii_purged_at = now() WHERE id = $1", [id])).toBe(
      "lead_pii_purged",
    );
    expect(
      await violation("UPDATE lead SET pii_purged_at = now(), email = NULL WHERE id = $1", [id]),
    ).toBeNull();
  });

  it("stores HubSpot portal and contact IDs together, unique per portal", async () => {
    const id = await lead();
    expect(await violation("UPDATE lead SET hubspot_contact_id = 501 WHERE id = $1", [id])).toBe(
      "lead_hubspot_ids_together",
    );
    await client.query(
      "UPDATE lead SET hubspot_portal_id = 900000001, hubspot_contact_id = 501 WHERE id = $1",
      [id],
    );
    const other = await lead("other@example.com");
    expect(
      await violation(
        "UPDATE lead SET hubspot_portal_id = 900000001, hubspot_contact_id = 501 WHERE id = $1",
        [other],
      ),
    ).toBe("lead_hubspot_portal_id_hubspot_contact_id_key");
    expect(
      await violation(
        "UPDATE lead SET hubspot_portal_id = 900000002, hubspot_contact_id = 501 WHERE id = $1",
        [other],
      ),
    ).toBeNull();
  });
});

describe("crm_event", () => {
  const insertEvent = `INSERT INTO crm_event (dedupe_key, portal_id, subscription_id, subscription_type,
      object_id, event_id, occurred_at, attempt_number, raw_payload)
    VALUES ($1, 900000001, 7001, 'object.creation', 501, 100, now(), $2, '{}')
    ON CONFLICT (dedupe_key) DO NOTHING`;
  const key = `v1:${"a".repeat(64)}`;

  it("stores a retried event once (ON CONFLICT on the dedupe key)", async () => {
    expect((await client.query(insertEvent, [key, 0])).rowCount).toBe(1);
    expect((await client.query(insertEvent, [key, 1])).rowCount).toBe(0);
    const { rows } = await client.query(
      "SELECT attempt_number FROM crm_event WHERE dedupe_key = $1",
      [key],
    );
    expect(rows).toEqual([{ attempt_number: 0 }]);
  });

  it("rejects a dedupe key that isn't a v1 hash", async () => {
    expect(await violation(insertEvent, ["evt-100", 0])).toBe("crm_event_dedupe_key_format");
  });
});

describe("agent_run", () => {
  it("allows only this project's statuses, including unknown", async () => {
    const id = await agentRun(await lead());
    expect(
      await violation("UPDATE agent_run SET status = 'unknown' WHERE id = $1", [id]),
    ).toBeNull();
    expect(await violation("UPDATE agent_run SET status = 'accepted' WHERE id = $1", [id])).toBe(
      "agent_run_status_known",
    );
  });

  it("refuses a second run with the same proposal run ID", async () => {
    const leadId = await lead();
    await agentRun(leadId);
    expect(
      await violation(
        `INSERT INTO agent_run (lead_id, workflow_id, workflow_version, mode, proposal_run_id, input_hash)
         VALUES ($1, 'wf_test', 1, 'propose', 'triage_test_0001', 'hash')`,
        [leadId],
      ),
    ).toBe("agent_run_proposal_run_id_key");
  });

  it("never gives a shadow run a resume run ID, and keeps confidence in 0..1", async () => {
    const id = await agentRun(await lead(), "shadow");
    expect(await violation("UPDATE agent_run SET resume_run_id = 'r2' WHERE id = $1", [id])).toBe(
      "agent_run_shadow_never_resumes",
    );
    expect(await violation("UPDATE agent_run SET confidence = 1.2 WHERE id = $1", [id])).toBe(
      "agent_run_confidence_range",
    );
  });
});

describe("approval", () => {
  it("is one per run, and a decision always comes with an approver and a time", async () => {
    const runId = await agentRun(await lead());
    const insert = `INSERT INTO approval (agent_run_id, sim_context_id, diff) VALUES ($1, 'human-block', '{}')`;
    expect(await violation(insert, [runId])).toBeNull();
    expect(await violation(insert, [runId])).toBe("approval_agent_run_id_key");
    expect(
      await violation("UPDATE approval SET decision = 'approved' WHERE agent_run_id = $1", [runId]),
    ).toBe("approval_decided_together");
    expect(
      await violation("UPDATE approval SET resumed_at = now() WHERE agent_run_id = $1", [runId]),
    ).toBe("approval_resumed_after_decision");
    expect(
      await violation(
        "UPDATE approval SET decision = 'approved', approver = 'operator', decided_at = now() WHERE agent_run_id = $1",
        [runId],
      ),
    ).toBeNull();
  });
});
