import { db, audit } from "../db.ts";
import { deleteSkillWithSnapshot, restoreSkill, approveVersion, rejectVersion, type SkillSnapshot } from "./service.ts";

// undo buffer for the last deletes; single process, single admin — memory is enough
let undoSeq = 0;
let undoBuffer: { id: number; snapshots: SkillSnapshot[]; actor: number | null }[] = [];

export function deleteSkills(names: string[], actorId: number | null): { deleted: string[]; missing: string[]; undo_id: number } {
  const missing: string[] = [];
  const snapshots: SkillSnapshot[] = [];
  for (const name of names) {
    const r = deleteSkillWithSnapshot(name);
    if (!r) { missing.push(name); continue; }
    snapshots.push(r.snapshot);
  }
  undoBuffer.unshift({ id: ++undoSeq, snapshots, actor: actorId });
  if (undoBuffer.length > 10) undoBuffer.pop();
  audit(actorId === null ? "admin" : "admin", actorId, "skill.delete.batch", { names, deleted: snapshots.length, missing });
  return { deleted: snapshots.map((s) => s.skill.name), missing, undo_id: undoBuffer[0].id };
}

export function undoDelete(undoId: number, actorId: number | null): { restored: string[]; skipped: string[] } | null {
  const entry = undoBuffer.find((u) => u.id === undoId && u.actor === actorId);
  if (!entry) return null;
  const restored: string[] = [];
  const skipped: string[] = [];
  for (const snap of entry.snapshots) {
    if (restoreSkill(snap)) restored.push(snap.skill.name);
    else skipped.push(snap.skill.name);
  }
  undoBuffer = undoBuffer.filter((u) => u.id !== undoId);
  audit("admin", actorId, "skill.restore", { restored, skipped });
  return { restored, skipped };
}

export function updateSkillMeta(
  name: string,
  patch: { status?: "draft" | "published" | "deprecated"; tags?: string[] },
  actorId: number | null,
): boolean {
  const s = db.prepare("SELECT id FROM skills WHERE name = ?").get(name) as any;
  if (!s) return false;
  if (patch.status) db.prepare("UPDATE skills SET status = ?, updated_at = datetime('now') WHERE id = ?").run(patch.status, s.id);
  if (patch.tags) {
    db.prepare("DELETE FROM skill_tags WHERE skill_id = ?").run(s.id);
    for (const raw of patch.tags) {
      const t = String(raw).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
      if (!t) continue;
      let row = db.prepare("SELECT id FROM tags WHERE name = ?").get(t) as any;
      if (!row) row = db.prepare("INSERT INTO tags (name) VALUES (?)").run(t);
      db.prepare("INSERT OR IGNORE INTO skill_tags (skill_id, tag_id) VALUES (?,?)").run(s.id, Number(row.lastInsertRowid ?? row.id));
    }
  }
  audit("admin", actorId, "skill.update", { name, ...patch });
  return true;
}

export { approveVersion, rejectVersion };
