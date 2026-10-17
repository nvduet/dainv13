const encoder = new TextEncoder();
const MAX_AMOUNT_VND = 1_000_000_000_000;
const MAX_MEMBERS = 50;
const DEFAULT_FONT_SIZE = 100;
const DEFAULT_COLUMN_WIDTHS = {
  expense: {
    payer: 110,
    date: 110,
    description: 145,
    amount: 100,
    member: 80,
    count: 52,
    avg: 94,
    actions: 68,
  },
  summary: {
    label: 120,
    member: 130,
  },
};
const COLUMN_WIDTH_LIMITS = {
  expense: {
    payer: [24, 2000],
    date: [24, 2000],
    description: [24, 2000],
    amount: [24, 2000],
    member: [24, 2000],
    count: [24, 2000],
    avg: [24, 2000],
    actions: [24, 2000],
  },
  summary: {
    label: [24, 2000],
    member: [24, 2000],
  },
};

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function error(message, status = 400) {
  return json({ error: message }, status);
}

async function readJson(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 100_000) throw new ApiError("Dữ liệu gửi lên quá lớn.", 413);
  let body;
  try {
    body = await request.json();
  } catch {
    throw new ApiError("Dữ liệu JSON không hợp lệ.", 400);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("Dữ liệu gửi lên phải là một đối tượng JSON.", 400);
  }
  return body;
}

function validName(value) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 80;
}

function validSignedAmount(value) {
  return Number.isSafeInteger(value) &&
    value >= -MAX_AMOUNT_VND &&
    value <= MAX_AMOUNT_VND;
}

function validId(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 80;
}

function validIds(value, { allowEmpty = false } = {}) {
  return Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.length <= MAX_MEMBERS &&
    value.every(validId) &&
    new Set(value).size === value.length;
}

function validColumnWidths(value) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(COLUMN_WIDTH_LIMITS).every((group) => {
      const widths = value[group];
      const limits = COLUMN_WIDTH_LIMITS[group];
      return widths !== null &&
        typeof widths === "object" &&
        !Array.isArray(widths) &&
        Object.keys(widths).length === Object.keys(limits).length &&
        Object.entries(limits).every(([key, [minimum, maximum]]) =>
          Number.isSafeInteger(widths[key]) &&
          widths[key] >= minimum &&
          widths[key] <= maximum,
        );
    }) &&
    Object.keys(value).length === Object.keys(COLUMN_WIDTH_LIMITS).length;
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

function encodeBase64Url(value) {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sign(payload, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return encodeBase64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

async function secureEqual(left, right) {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const bytesA = new Uint8Array(a);
  const bytesB = new Uint8Array(b);
  let difference = 0;
  for (let index = 0; index < bytesA.length; index += 1) difference |= bytesA[index] ^ bytesB[index];
  return difference === 0;
}

async function sessionCookie(username, env, request) {
  const payload = encodeBase64Url(encoder.encode(JSON.stringify({
    username,
    expires: Date.now() + 8 * 60 * 60 * 1000,
  })));
  const signature = await sign(payload, env.ADMIN_SESSION_SECRET);
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `admin_session=${payload}.${signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure}`;
}

async function isAdmin(request, env) {
  if (!env.ADMIN_SESSION_SECRET) return false;
  const cookie = request.headers.get("cookie") || "";
  const token = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("admin_session="));
  if (!token) return false;
  const value = token.slice("admin_session=".length);
  const separator = value.lastIndexOf(".");
  if (separator < 1) return false;
  const payload = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (!(await secureEqual(signature, await sign(payload, env.ADMIN_SESSION_SECRET)))) return false;
  try {
    const details = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)));
    return details.username === env.ADMIN_USERNAME && Number(details.expires) > Date.now();
  } catch {
    return false;
  }
}

async function rateLimit(request, env, label, limit, windowMs) {
  const address = request.headers.get("cf-connecting-ip") || "local";
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(address));
  const key = `${label}:${encodeBase64Url(digest).slice(0, 24)}`;
  const windowStart = Math.floor(Date.now() / windowMs) * Math.ceil(windowMs / 1000);
  const row = await env.DB.prepare(`
    INSERT INTO rate_limits (bucket_key, window_start, hit_count)
    VALUES (?, ?, 1)
    ON CONFLICT (bucket_key, window_start)
    DO UPDATE SET hit_count = hit_count + 1
    RETURNING hit_count
  `).bind(key, windowStart).first();
  return Number(row?.hit_count || 0) <= limit;
}

function audit(env, actor, action, entity, entityId, before, after) {
  return env.DB.prepare(`
    INSERT INTO audit_log (actor, action, entity, entity_id, before_json, after_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    actor,
    action,
    entity,
    String(entityId),
    before == null ? null : JSON.stringify(before),
    after == null ? null : JSON.stringify(after),
  );
}

async function getExpense(env, id) {
  const expense = await env.DB.prepare(`
    SELECT id, payer_id AS payerId, description, amount_vnd AS amountVnd,
           expense_date AS date,
           created_at AS createdAt, updated_at AS updatedAt
    FROM expenses WHERE id = ?
  `).bind(id).first();
  if (!expense) return null;
  const participants = await env.DB.prepare(`
    SELECT member_id AS memberId FROM expense_participants
    WHERE expense_id = ? ORDER BY member_id
  `).bind(id).all();
  return { ...expense, participantIds: participants.results.map((row) => row.memberId) };
}

function validExpenseDate(value) {
  if (value === null || value === "") return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

async function validateExpensePatch(env, body, before) {
  const allowedFields = new Set(["payerId", "date", "description", "amountVnd", "participantIds"]);
  const fields = Object.keys(body);
  if (fields.length === 0 || fields.some((field) => !allowedFields.has(field))) {
    return "Không có trường khoản chi hợp lệ để lưu.";
  }
  if (Object.hasOwn(body, "payerId") &&
      body.payerId !== null && body.payerId !== "" && !validId(body.payerId)) {
    return "Người chi không hợp lệ.";
  }
  if (Object.hasOwn(body, "date") && !validExpenseDate(body.date)) {
    return "Ngày phải có định dạng YYYY-MM-DD hợp lệ.";
  }
  if (Object.hasOwn(body, "description") &&
      (typeof body.description !== "string" || body.description.length > 200)) {
    return "Nội dung không được dài quá 200 ký tự.";
  }
  if (Object.hasOwn(body, "amountVnd") &&
      (!Number.isSafeInteger(body.amountVnd) ||
       body.amountVnd < -MAX_AMOUNT_VND ||
       body.amountVnd > MAX_AMOUNT_VND)) {
    return "Số tiền phải là số đồng nguyên trong giới hạn cho phép.";
  }
  if (Object.hasOwn(body, "participantIds") && !validIds(body.participantIds, { allowEmpty: true })) {
    return "Danh sách người tham gia không hợp lệ.";
  }
  const ids = new Set();
  if (Object.hasOwn(body, "payerId") && body.payerId) ids.add(body.payerId);
  else if (before.payerId) ids.add(before.payerId);
  const participantIds = Object.hasOwn(body, "participantIds")
    ? body.participantIds
    : before.participantIds;
  participantIds.forEach((id) => ids.add(id));
  if (ids.size > 0) {
    const memberIds = [...ids];
    const placeholders = memberIds.map(() => "?").join(",");
    const result = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM members WHERE id IN (${placeholders})`,
    ).bind(...memberIds).first();
    if (Number(result.count) !== memberIds.length) {
      return "Một hoặc nhiều thành viên không còn tồn tại.";
    }
  }
  return null;
}

async function state(request, env) {
  const [membersResult, expensesResult, participantResult, paymentsResult, adjustmentsResult, settingsResult, fontSizeResult, admin] = await Promise.all([
    env.DB.prepare("SELECT id, name, position FROM members ORDER BY position, name COLLATE NOCASE").all(),
    env.DB.prepare(`
      SELECT id, payer_id AS payerId, description, amount_vnd AS amountVnd,
             expense_date AS date, created_at AS createdAt, updated_at AS updatedAt
      FROM expenses ORDER BY position, created_at, id
    `).all(),
    env.DB.prepare("SELECT expense_id AS expenseId, member_id AS memberId FROM expense_participants").all(),
    env.DB.prepare(`
      SELECT id, member_id AS memberId, direction, amount_vnd AS amountVnd,
             status, created_at AS createdAt, confirmed_at AS confirmedAt
      FROM payments WHERE status = 'confirmed' ORDER BY created_at DESC, id DESC
    `).all(),
    env.DB.prepare(`
      SELECT id, member_id AS memberId, amount_delta_vnd AS amountVnd,
             created_at AS createdAt
      FROM payment_adjustments ORDER BY created_at DESC, id DESC
    `).all(),
    env.DB.prepare("SELECT value_json AS valueJson FROM app_settings WHERE key = 'column-widths'").first(),
    env.DB.prepare("SELECT value_json AS valueJson FROM app_settings WHERE key = 'font-size'").first(),
    isAdmin(request, env),
  ]);
  const participants = new Map();
  for (const row of participantResult.results) {
    const list = participants.get(row.expenseId) || [];
    list.push(row.memberId);
    participants.set(row.expenseId, list);
  }
  return json({
    members: membersResult.results,
    expenses: expensesResult.results.map((expense) => ({
      ...expense,
      participantIds: participants.get(expense.id) || [],
    })),
    payments: [
      ...paymentsResult.results,
      ...adjustmentsResult.results.map((adjustment) => ({
        ...adjustment,
        id: `adjustment-${adjustment.id}`,
        direction: "member_to_admin",
        status: "confirmed",
        confirmedAt: adjustment.createdAt,
        adjustment: true,
      })),
    ].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))),
    isAdmin: admin,
    columnWidths: settingsResult
      ? JSON.parse(settingsResult.valueJson)
      : DEFAULT_COLUMN_WIDTHS,
    fontSize: fontSizeResult ? Number(fontSizeResult.valueJson) : DEFAULT_FONT_SIZE,
  });
}

async function handleApi(request, env) {
  if (!env.DB) return error("Database chưa được cấu hình. Hãy chạy migrations D1 trước.", 503);
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (method === "GET" && path === "/api/state") return state(request, env);
  if (method === "GET" && path === "/api/admin/session") return json({ isAdmin: await isAdmin(request, env) });

  if (method !== "GET" && method !== "HEAD") {
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return error("Yêu cầu khác nguồn bị từ chối.", 403);
  }

  if (method === "POST" && path === "/api/admin/login") {
    if (!(await rateLimit(request, env, "login", 10, 60 * 60 * 1000))) {
      return error("Quá nhiều lần đăng nhập. Hãy thử lại sau.", 429);
    }
    if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET) {
      return error("Thiếu cấu hình đăng nhập Admin phía server.", 503);
    }
    const body = await readJson(request);
    const usernameMatches = await secureEqual(String(body.username || ""), env.ADMIN_USERNAME);
    const passwordMatches = await secureEqual(String(body.password || ""), env.ADMIN_PASSWORD);
    if (!usernameMatches || !passwordMatches) return error("Tên đăng nhập hoặc mật khẩu không đúng.", 401);
    return json({ isAdmin: true }, 200, {
      "set-cookie": await sessionCookie(env.ADMIN_USERNAME, env, request),
    });
  }

  if (method === "POST" && path === "/api/admin/logout") {
    return json({ isAdmin: false }, 200, {
      "set-cookie": "admin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
    });
  }

  const admin = await isAdmin(request, env);
  const adminOnly = new Set([
    "POST /api/members",
    "PUT /api/admin/payments/total",
    "PUT /api/admin/font-size",
    "POST /api/admin/history-points",
  ]);
  const routeKey = `${method} ${path}`;
  if ((adminOnly.has(routeKey) || /^PATCH \/api\/members\/[^/]+$/.test(routeKey) ||
       /^DELETE \/api\/members\/[^/]+$/.test(routeKey) ||
       (method === "POST" && /^\/api\/admin\/history-points\/[^/]+\/restore$/.test(path)) ||
       (method === "PUT" && path === "/api/admin/column-widths") ||
       path === "/api/admin/audit" ||
       path === "/api/admin/history-points") && !admin) {
    return error("Chỉ Admin đã đăng nhập mới được thực hiện thao tác này.", 401);
  }

  if (path === "/api/admin/audit" && method === "GET") {
    const result = await env.DB.prepare(`
      SELECT id, actor, action, entity, entity_id AS entityId,
             before_json AS beforeJson, after_json AS afterJson, created_at AS createdAt
      FROM audit_log ORDER BY id DESC LIMIT 200
    `).all();
    return json({ entries: result.results });
  }

  if (path === "/api/admin/history-points" && method === "GET") {
    const result = await env.DB.prepare(`
      SELECT id, created_at AS createdAt, member_count AS memberCount,
             expense_count AS expenseCount
      FROM history_points ORDER BY created_at DESC, rowid DESC LIMIT 50
    `).all();
    return json({ points: result.results });
  }

  if (method === "POST" && path === "/api/admin/history-points") {
    if (!await rateLimit(request, env, "write", 500, 15 * 60 * 1000)) {
      return error("Đã vượt giới hạn thao tác. Hãy thử lại sau.", 429);
    }
    const [membersResult, expensesResult, participantsResult, paymentsResult, adjustmentsResult] =
      await env.DB.batch([
        env.DB.prepare("SELECT id, name, position, created_at AS createdAt FROM members ORDER BY position, name COLLATE NOCASE"),
        env.DB.prepare(`SELECT id, payer_id AS payerId, description, amount_vnd AS amountVnd,
          expense_date AS date, position, created_at AS createdAt, updated_at AS updatedAt
          FROM expenses ORDER BY position, created_at, id`),
        env.DB.prepare("SELECT expense_id AS expenseId, member_id AS memberId FROM expense_participants ORDER BY expense_id, member_id"),
        env.DB.prepare(`SELECT id, member_id AS memberId, direction, amount_vnd AS amountVnd,
          status, created_at AS createdAt, confirmed_at AS confirmedAt, confirmed_by AS confirmedBy
          FROM payments ORDER BY created_at, id`),
        env.DB.prepare(`SELECT id, member_id AS memberId, amount_delta_vnd AS amountVnd,
          created_by AS createdBy, created_at AS createdAt
          FROM payment_adjustments ORDER BY created_at, id`),
      ]);
    const snapshot = {
      members: membersResult.results,
      expenses: expensesResult.results,
      participants: participantsResult.results,
      payments: paymentsResult.results,
      adjustments: adjustmentsResult.results,
    };
    const id = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO history_points (id, snapshot_json, member_count, expense_count)
        VALUES (?, ?, ?, ?)
      `).bind(id, JSON.stringify(snapshot), snapshot.members.length, snapshot.expenses.length),
      env.DB.prepare(`
        DELETE FROM history_points
        WHERE id NOT IN (
          SELECT id FROM history_points ORDER BY created_at DESC, rowid DESC LIMIT 50
        )
      `),
      audit(env, "admin", "store", "history_point", id, null, {
        memberCount: snapshot.members.length,
        expenseCount: snapshot.expenses.length,
      }),
    ]);
    return json({ point: { id, memberCount: snapshot.members.length, expenseCount: snapshot.expenses.length } }, 201);
  }

  const historyRestoreMatch = path.match(/^\/api\/admin\/history-points\/([^/]+)\/restore$/);
  if (method === "POST" && historyRestoreMatch) {
    if (!await rateLimit(request, env, "restore-password", 10, 15 * 60 * 1000)) {
      return error("Đã vượt số lần nhập mật khẩu khôi phục. Hãy thử lại sau.", 429);
    }
    if (!env.HISTORY_RESTORE_PASSWORD) {
      return error("Chưa cấu hình mật khẩu khôi phục riêng phía máy chủ.", 503);
    }
    if (await secureEqual(env.HISTORY_RESTORE_PASSWORD, env.ADMIN_PASSWORD || "")) {
      return error("Mật khẩu khôi phục phải khác mật khẩu Admin. Hãy cấu hình lại secret.", 503);
    }
    const body = await readJson(request);
    if (typeof body.password !== "string" || body.password.length === 0) {
      return error("Nhập mật khẩu khôi phục riêng.");
    }
    if (!await secureEqual(body.password, env.HISTORY_RESTORE_PASSWORD)) {
      return error("Mật khẩu khôi phục không đúng.", 401);
    }
    const id = decodeURIComponent(historyRestoreMatch[1]);
    const point = await env.DB.prepare(
      "SELECT snapshot_json AS snapshotJson FROM history_points WHERE id = ?",
    ).bind(id).first();
    if (!point) return error("Không tìm thấy điểm khôi phục.", 404);
    let snapshot;
    try {
      snapshot = JSON.parse(point.snapshotJson);
    } catch {
      return error("Dữ liệu điểm khôi phục bị lỗi.", 500);
    }
    if (!snapshot || !Array.isArray(snapshot.members) || !Array.isArray(snapshot.expenses) ||
        !Array.isArray(snapshot.participants) || !Array.isArray(snapshot.payments) ||
        !Array.isArray(snapshot.adjustments)) {
      return error("Cấu trúc điểm khôi phục không hợp lệ.", 500);
    }
    const snapshotJson = JSON.stringify(snapshot);
    const statements = [
      env.DB.prepare("DELETE FROM expenses"),
      env.DB.prepare("DELETE FROM payments"),
      env.DB.prepare("DELETE FROM payment_adjustments"),
      env.DB.prepare("DELETE FROM members"),
      env.DB.prepare(`
        INSERT INTO members (id, name, position, created_at)
        SELECT json_extract(value, '$.id'), json_extract(value, '$.name'),
          json_extract(value, '$.position'), json_extract(value, '$.createdAt')
        FROM json_each(?, '$.members')
      `).bind(snapshotJson),
      env.DB.prepare(`
        INSERT INTO expenses (id, payer_id, description, amount_vnd, expense_date,
          position, created_at, updated_at)
        SELECT json_extract(value, '$.id'), json_extract(value, '$.payerId'),
          json_extract(value, '$.description'), json_extract(value, '$.amountVnd'),
          json_extract(value, '$.date'), json_extract(value, '$.position'),
          json_extract(value, '$.createdAt'), json_extract(value, '$.updatedAt')
        FROM json_each(?, '$.expenses')
      `).bind(snapshotJson),
      env.DB.prepare(`
        INSERT INTO expense_participants (expense_id, member_id)
        SELECT json_extract(value, '$.expenseId'), json_extract(value, '$.memberId')
        FROM json_each(?, '$.participants')
      `).bind(snapshotJson),
      env.DB.prepare(`
        INSERT INTO payments (id, member_id, direction, amount_vnd, status,
          created_at, confirmed_at, confirmed_by)
        SELECT json_extract(value, '$.id'), json_extract(value, '$.memberId'),
          json_extract(value, '$.direction'), json_extract(value, '$.amountVnd'),
          json_extract(value, '$.status'), json_extract(value, '$.createdAt'),
          json_extract(value, '$.confirmedAt'), json_extract(value, '$.confirmedBy')
        FROM json_each(?, '$.payments')
      `).bind(snapshotJson),
      env.DB.prepare(`
        INSERT INTO payment_adjustments (id, member_id, amount_delta_vnd, created_by, created_at)
        SELECT json_extract(value, '$.id'), json_extract(value, '$.memberId'),
          json_extract(value, '$.amountVnd'), json_extract(value, '$.createdBy'),
          json_extract(value, '$.createdAt')
        FROM json_each(?, '$.adjustments')
      `).bind(snapshotJson),
      audit(env, "admin", "restore", "history_point", id, null, {
        memberCount: snapshot.members.length,
        expenseCount: snapshot.expenses.length,
      }),
    ];
    await env.DB.batch(statements);
    return json({ restored: true });
  }

  if (method !== "GET" && !(await rateLimit(
    request,
    env,
    "write",
    admin ? 500 : 120,
    15 * 60 * 1000,
  ))) {
    return error("Đã vượt giới hạn thao tác. Hãy thử lại sau.", 429);
  }

  if (method === "PUT" && path === "/api/admin/column-widths") {
    const body = await readJson(request);
    if (!validColumnWidths(body)) {
      return error("Độ rộng cột không hợp lệ hoặc nằm ngoài giới hạn cho phép.");
    }
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO app_settings (key, value_json) VALUES ('column-widths', ?)
        ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json
      `).bind(JSON.stringify(body)),
      audit(env, "admin", "configure", "settings", "column-widths", null, body),
    ]);
    return json({ columnWidths: body });
  }

  if (method === "PUT" && path === "/api/admin/font-size") {
    const body = await readJson(request);
    if (!Number.isSafeInteger(body.fontSize) || body.fontSize < 75 || body.fontSize > 200) {
      return error("Cỡ chữ phải nằm trong khoảng 75% đến 200%.");
    }
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO app_settings (key, value_json) VALUES ('font-size', ?)
        ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json
      `).bind(String(body.fontSize)),
      audit(env, "admin", "configure", "settings", "font-size", null, { fontSize: body.fontSize }),
    ]);
    return json({ fontSize: body.fontSize });
  }

  if (method === "PUT" && path === "/api/admin/payments/total") {
    const body = await readJson(request);
    if (!validId(body.memberId) || !validSignedAmount(body.amountVnd)) {
      return error("Chọn thành viên và nhập tổng tiền chuyển khoản hợp lệ.");
    }
    const member = await env.DB.prepare("SELECT id, name FROM members WHERE id = ?")
      .bind(body.memberId).first();
    if (!member) return error("Thành viên không tồn tại.", 404);
    const [paymentsResult, adjustmentsResult] = await Promise.all([
      env.DB.prepare(`
        SELECT COALESCE(SUM(amount_vnd), 0) AS total
        FROM payments
        WHERE member_id = ? AND direction = 'member_to_admin' AND status = 'confirmed'
      `).bind(body.memberId).first(),
      env.DB.prepare(`
        SELECT COALESCE(SUM(amount_delta_vnd), 0) AS total
        FROM payment_adjustments WHERE member_id = ?
      `).bind(body.memberId).first(),
    ]);
    const currentTotal = Number(paymentsResult.total) + Number(adjustmentsResult.total);
    const delta = body.amountVnd - currentTotal;
    if (delta === 0) return json({ amountVnd: body.amountVnd, changed: false });

    const adjustment = {
      id: crypto.randomUUID(),
      memberId: body.memberId,
      amountVnd: delta,
      status: "confirmed",
    };
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO payment_adjustments (id, member_id, amount_delta_vnd, created_by)
        VALUES (?, ?, ?, 'admin')
      `).bind(adjustment.id, adjustment.memberId, adjustment.amountVnd),
      audit(
        env,
        "admin",
        "reconcile",
        "payment_total",
        body.memberId,
        { memberId: body.memberId, paidToAdminVnd: currentTotal },
        { memberId: body.memberId, paidToAdminVnd: body.amountVnd, adjustmentVnd: delta },
      ),
    ]);
    return json({ amountVnd: body.amountVnd, adjustmentVnd: delta });
  }

  if (method === "POST" && path === "/api/expenses") {
    const id = crypto.randomUUID();
    const position = await env.DB.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM expenses").first();
    const expense = {
      id,
      payerId: null,
      date: null,
      description: "",
      amountVnd: 0,
      participantIds: [],
    };
    const statements = [
      env.DB.prepare(`
        INSERT INTO expenses (id, payer_id, description, amount_vnd, expense_date, position)
        VALUES (?, NULL, '', 0, NULL, ?)
      `).bind(id, Number(position.next)),
      audit(env, admin ? "admin" : "public", "create", "expense", id, null, expense),
    ];
    await env.DB.batch(statements);
    return json({ expense: { ...expense, createdAt: null, updatedAt: null } }, 201);
  }

  const expenseMatch = path.match(/^\/api\/expenses\/([^/]+)$/);
  if (expenseMatch && ["PUT", "DELETE"].includes(method)) {
    const id = decodeURIComponent(expenseMatch[1]);
    const before = await getExpense(env, id);
    if (!before) return error("Không tìm thấy khoản chi.", 404);
    if (method === "DELETE") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM expenses WHERE id = ?").bind(id),
        audit(env, admin ? "admin" : "public", "delete", "expense", id, before, null),
      ]);
      return json({ deleted: true });
    }
    const body = await readJson(request);
    const problem = await validateExpensePatch(env, body, before);
    if (problem) return error(problem);
    const after = {
      ...before,
      payerId: Object.hasOwn(body, "payerId")
        ? body.payerId || null
        : before.payerId,
      date: Object.hasOwn(body, "date")
        ? body.date || null
        : before.date,
      description: Object.hasOwn(body, "description")
        ? body.description.trim()
        : before.description,
      amountVnd: Object.hasOwn(body, "amountVnd")
        ? body.amountVnd
        : before.amountVnd,
      participantIds: Object.hasOwn(body, "participantIds")
        ? body.participantIds
        : before.participantIds,
    };
    const auditStatements = [];
    for (const field of ["payerId", "date", "description", "amountVnd"]) {
      if (before[field] !== after[field]) {
        auditStatements.push(audit(
          env,
          admin ? "admin" : "public",
          "update",
          "expense",
          id,
          { field, value: before[field] },
          { field, value: after[field] },
        ));
      }
    }
    const previousParticipants = new Set(before.participantIds);
    const currentParticipants = new Set(after.participantIds);
    for (const memberId of currentParticipants) {
      if (!previousParticipants.has(memberId)) {
        auditStatements.push(audit(
          env,
          admin ? "admin" : "public",
          "participant_add",
          "expense_participant",
          `${id}:${memberId}`,
          null,
          { expenseId: id, memberId },
        ));
      }
    }
    for (const memberId of previousParticipants) {
      if (!currentParticipants.has(memberId)) {
        auditStatements.push(audit(
          env,
          admin ? "admin" : "public",
          "participant_remove",
          "expense_participant",
          `${id}:${memberId}`,
          { expenseId: id, memberId },
          null,
        ));
      }
    }
    const fieldColumns = {
      payerId: "payer_id",
      date: "expense_date",
      description: "description",
      amountVnd: "amount_vnd",
    };
    const changedFields = Object.keys(fieldColumns).filter((field) => Object.hasOwn(body, field));
    const updateValues = changedFields.map((field) => after[field]);
    const updateColumns = changedFields.map((field) => `${fieldColumns[field]} = ?`);
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE expenses SET ${[...updateColumns, "updated_at = CURRENT_TIMESTAMP"].join(", ")}
        WHERE id = ?
      `).bind(...updateValues, id),
      ...(Object.hasOwn(body, "participantIds") ? [
        env.DB.prepare("DELETE FROM expense_participants WHERE expense_id = ?").bind(id),
        ...after.participantIds.map((memberId) => env.DB.prepare(`
          INSERT INTO expense_participants (expense_id, member_id) VALUES (?, ?)
        `).bind(id, memberId)),
      ] : []),
      ...auditStatements,
    ]);
    return json({ expense: await getExpense(env, id) });
  }

  if (method === "POST" && path === "/api/members") {
    if (!await rateLimit(request, env, "member", 50, 60 * 60 * 1000)) return error("Đã vượt giới hạn.", 429);
    const body = await readJson(request);
    if (!validName(body.name)) return error("Tên thành viên cần có từ 1 đến 80 ký tự.");
    const duplicate = await env.DB.prepare("SELECT id FROM members WHERE name = ?").bind(body.name.trim()).first();
    if (duplicate) return error("Tên thành viên này đã có trong danh sách.", 409);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM members").first();
    if (Number(count.count) >= MAX_MEMBERS) return error("Danh sách đã đạt giới hạn 50 thành viên.");
    const id = crypto.randomUUID();
    const nextPosition = await env.DB.prepare(
      "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM members",
    ).first();
    const position = Number(nextPosition.next);
    const member = { id, name: body.name.trim(), position };
    await env.DB.batch([
      env.DB.prepare("INSERT INTO members (id, name, position) VALUES (?, ?, ?)").bind(id, member.name, position),
      audit(env, "admin", "create", "member", id, null, member),
    ]);
    return json({ member }, 201);
  }

  const memberMatch = path.match(/^\/api\/members\/([^/]+)$/);
  if (memberMatch && ["PATCH", "DELETE"].includes(method)) {
    const id = decodeURIComponent(memberMatch[1]);
    const before = await env.DB.prepare(`
      SELECT id, name, position FROM members WHERE id = ?
    `).bind(id).first();
    if (!before) return error("Không tìm thấy thành viên.", 404);
    if (method === "PATCH") {
      const body = await readJson(request);
      if (!validName(body.name)) return error("Tên thành viên cần có từ 1 đến 80 ký tự.");
      const duplicate = await env.DB.prepare(
        "SELECT id FROM members WHERE name = ? AND id <> ?",
      ).bind(body.name.trim(), id).first();
      if (duplicate) return error("Tên thành viên này đã có trong danh sách.", 409);
      const after = { ...before, name: body.name.trim() };
      await env.DB.batch([
        env.DB.prepare("UPDATE members SET name = ? WHERE id = ?").bind(after.name, id),
        audit(env, "admin", "rename", "member", id, before, after),
      ]);
      return json({ member: after });
    }
    const impact = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM expenses
      WHERE payer_id = ? OR id IN (
        SELECT expense_id FROM expense_participants WHERE member_id = ?
      )
    `).bind(id, id).first();
    await env.DB.batch([
      env.DB.prepare(`
        DELETE FROM expenses
        WHERE payer_id = ? OR id IN (
          SELECT expense_id FROM expense_participants WHERE member_id = ?
        )
      `).bind(id, id),
      env.DB.prepare("DELETE FROM members WHERE id = ?").bind(id),
      audit(
        env,
        "admin",
        "hard_delete",
        "member",
        id,
        { ...before, impactedExpenses: Number(impact.count) },
        null,
      ),
    ]);
    return json({ deleted: true, impactedExpenses: Number(impact.count) });
  }

  return error("Không tìm thấy API.", 404);
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env);
      return await env.ASSETS.fetch(request);
    } catch (caught) {
      if (!(caught instanceof ApiError)) console.error("Request failed", caught);
      if (caught instanceof ApiError) return error(caught.message, caught.status);
      return error("Đã xảy ra lỗi máy chủ. Hãy thử lại; nếu vẫn tiếp diễn, liên hệ Admin.", 500);
    }
  },
};
