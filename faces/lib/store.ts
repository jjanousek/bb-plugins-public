// Which face each thread has. One row per thread the plugin has seen, in the
// plugin's own SQLite database. A face is given once and kept, so a thread's
// face never changes unless someone changes it.
import type { Database } from "better-sqlite3";
import type { FaceRow } from "./contract.ts";
import { faceFromKey, faceKey, nextFace, pickFace, type Face } from "./faces.ts";

/** Append only: bb runs each statement once, by its position. */
export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS faces (
    thread_id TEXT PRIMARY KEY,
    face TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0
  )`,
];

export interface StoredFace extends FaceRow {
  threadId: string;
  archived: boolean;
}

interface Row {
  thread_id: string;
  face: string;
  hidden: number;
  archived: number;
}

function toStored(row: Row): StoredFace {
  return { threadId: row.thread_id, face: row.face, hidden: row.hidden === 1, archived: row.archived === 1 };
}

export function createStore(db: Database) {
  const select = db.prepare(`SELECT thread_id, face, hidden, archived FROM faces WHERE thread_id = ?`);
  const insert = db.prepare(`INSERT INTO faces (thread_id, face) VALUES (?, ?)`);
  const writeFace = db.prepare(`UPDATE faces SET face = ?, hidden = 0 WHERE thread_id = ?`);
  const writeHidden = db.prepare(`UPDATE faces SET hidden = ? WHERE thread_id = ?`);
  const writeArchived = db.prepare(`UPDATE faces SET archived = ? WHERE thread_id = ?`);
  const remove = db.prepare(`DELETE FROM faces WHERE thread_id = ?`);
  // Archived threads give their faces back: they are out of the sidebar, and
  // keeping theirs would run out of faces for a long-time user.
  const liveFaces = db.prepare(`SELECT face FROM faces WHERE archived = 0 AND thread_id != ?`);

  const read = (threadId: string): StoredFace | null => {
    const row = select.get(threadId) as Row | undefined;
    return row === undefined ? null : toStored(row);
  };
  /** The faces other live threads hold. */
  const takenBesides = (threadId: string): Set<string> =>
    new Set((liveFaces.all(threadId) as { face: string }[]).map((row) => row.face));
  /** The thread's row, giving it its first face when it has none. */
  const ensure = (threadId: string): StoredFace => {
    const existing = read(threadId);
    if (existing !== null) return existing;
    const face = faceKey(pickFace(threadId, takenBesides(threadId)));
    insert.run(threadId, face);
    return { threadId, face, hidden: false, archived: false };
  };
  const row = (stored: StoredFace): FaceRow => ({ face: stored.face, hidden: stored.hidden });

  return {
    /** The faces of these threads, in one transaction, giving each new one its first face in the order given. */
    faces(threadIds: readonly string[]): Record<string, FaceRow> {
      return db.transaction(() => {
        const out: Record<string, FaceRow> = {};
        for (const threadId of threadIds) out[threadId] = row(ensure(threadId));
        return out;
      })();
    },
    /** Give the thread this face, and show it. */
    setFace(threadId: string, face: Face): FaceRow {
      return db.transaction(() => {
        ensure(threadId);
        writeFace.run(faceKey(face), threadId);
        return row(read(threadId)!);
      })();
    },
    /** Give the thread the next face along that no other live thread has, and show it. */
    newFace(threadId: string): FaceRow {
      return db.transaction(() => {
        const current = faceFromKey(ensure(threadId).face) ?? pickFace(threadId, new Set());
        writeFace.run(faceKey(nextFace(current, takenBesides(threadId))), threadId);
        return row(read(threadId)!);
      })();
    },
    setHidden(threadId: string, hidden: boolean): FaceRow {
      return db.transaction(() => {
        ensure(threadId);
        writeHidden.run(hidden ? 1 : 0, threadId);
        return row(read(threadId)!);
      })();
    },
    /** A thread was archived or brought back. Only a thread the plugin has seen has a row to mark. */
    setArchived(threadId: string, archived: boolean): void {
      writeArchived.run(archived ? 1 : 0, threadId);
    },
    /** A thread was deleted: its face is free again. */
    forget(threadId: string): void {
      remove.run(threadId);
    },
    /** Every live thread's face, for the command line. */
    list(): StoredFace[] {
      return (db.prepare(`SELECT thread_id, face, hidden, archived FROM faces WHERE archived = 0 ORDER BY thread_id`).all() as Row[]).map(
        toStored,
      );
    },
  };
}
