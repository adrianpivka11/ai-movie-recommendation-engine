// Run against an isolated local PostgreSQL database with both job SQL files applied.
// Requires psql on PATH and the anon/authenticated/service_role test roles.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const port = process.env.JOB_TEST_PGPORT ?? "55483";
const id = randomUUID();

async function query(sql) {
  const { stdout } = await execFileAsync("psql", [
    "-X", "-w", "-qAt", "-h", "127.0.0.1", "-p", port,
    "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql,
  ], { windowsHide: true, timeout: 15_000 });
  return stdout.trim();
}

try {
  await query(`INSERT INTO public.recommendation_jobs(id, query) VALUES ('${id}', 'Concurrent claim test')`);
  // Separate processes mean separate PostgreSQL transactions. Hold the winning
  // row lock briefly so the other connection must wait and recheck the lease.
  const claim = () => query(`
    BEGIN;
    SET LOCAL ROLE service_role;
    SELECT count(*) FROM public.claim_recommendation_job('${id}', 300, 3);
    SELECT pg_sleep(0.5);
    COMMIT;
  `);
  // Wait for BOTH connections even if one fails, before cleaning up the fixture.
  const outcomes = await Promise.allSettled([claim(), claim()]);
  const claims = outcomes.map((outcome) => {
    if (outcome.status === "rejected") throw outcome.reason;
    return outcome.value;
  });
  assert.deepEqual(claims.sort(), ["0", "1"]);
  assert.equal(await query(`SELECT attempt_count FROM public.recommendation_jobs WHERE id = '${id}'`), "1");
  console.log("PASS: concurrent claims grant exactly one lease and increment attempts once.");
} finally {
  await query(`DELETE FROM public.recommendation_jobs WHERE id = '${id}'`);
}
