import { MAX_AUDIT_SESSIONS } from "../../public/shared/constants.mjs";
import { decodePathParam, error, json } from "../http.js";

export async function listAuditSessions({ db }) {
  const result = await db.prepare(`
    SELECT id, started_at AS startedAt, last_activity AS lastActivity,
           admin_seen AS adminSeen, guest_seen AS guestSeen
    FROM audit_sessions ORDER BY last_activity DESC, rowid DESC
    LIMIT ${MAX_AUDIT_SESSIONS}
  `).all();
  return json({ sessions: result.results });
}

// A session's "before" is the previous session's "after", or the anchor for the oldest one.
export async function getAuditSession({ db, params }) {
  const id = decodePathParam(params[0]);
  const result = id === null ? null : await db.prepare(`
    SELECT current.id, current.started_at AS startedAt,
           current.last_activity AS lastActivity,
           current.admin_seen AS adminSeen, current.guest_seen AS guestSeen,
           COALESCE(
             (SELECT previous.after_json FROM audit_sessions previous
              WHERE previous.rowid < current.rowid
              ORDER BY previous.rowid DESC LIMIT 1),
             (SELECT snapshot_json FROM audit_session_anchor WHERE id = 1)
           ) AS beforeJson,
           current.after_json AS afterJson
    FROM audit_sessions current WHERE current.id = ?
  `).bind(id).first();
  if (!result) return error("Không tìm thấy phiên nhật ký.", 404);
  try {
    return json({
      session: {
        id: result.id,
        startedAt: result.startedAt,
        lastActivity: result.lastActivity,
        actors: [
          ...(result.adminSeen ? ["admin"] : []),
          ...(result.guestSeen ? ["guest"] : []),
        ],
        before: JSON.parse(result.beforeJson),
        after: JSON.parse(result.afterJson),
      },
    });
  } catch {
    return error("Dữ liệu phiên nhật ký bị lỗi.", 500);
  }
}
