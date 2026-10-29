import { db } from "../db.ts";
import { importFromUrl } from "../ingest/import.ts";

// In-process scheduler: refresh sources with auto_refresh_hours set. No cron dep.
let started = false;
export function startSourceScheduler() {
  if (started) return;
  started = true;
  const timer = setInterval(async () => {
    try {
      const due = db
        .prepare(
          `SELECT * FROM sources WHERE enabled = 1 AND auto_refresh_hours IS NOT NULL
           AND (last_run_at IS NULL OR last_run_at < datetime('now', '-' || auto_refresh_hours || ' hours'))`,
        )
        .all() as any[];
      for (const s of due) {
        try {
          await importFromUrl(s.url);
          db.prepare("UPDATE sources SET last_run_at = datetime('now'), last_status = 'ok (scheduled)' WHERE id = ?").run(s.id);
        } catch (e: any) {
          db.prepare("UPDATE sources SET last_run_at = datetime('now'), last_status = ? WHERE id = ?").run(
            `error: ${String(e.message).slice(0, 200)}`,
            s.id,
          );
        }
      }
    } catch {
      // never crash the process
    }
  }, 60_000);
  timer.unref?.();
}
