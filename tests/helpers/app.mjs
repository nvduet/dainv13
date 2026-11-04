import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker from "../../worker/index.js";
import { createTestDatabase } from "./d1-sqlite.mjs";

export const ORIGIN = "https://so-chi.test";
export const SECRETS = {
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD: "admin-password",
  ADMIN_SESSION_SECRET: "integration-session-secret-0123456789",
  HISTORY_RESTORE_PASSWORD: "restore-password",
};

// The worker over an in-memory node:sqlite database with every migration applied.
export function createApp(secrets = SECRETS, { db = createTestDatabase() } = {}) {
  const assetRequests = [];
  const env = {
    DB: db,
    ASSETS: {
      async fetch(request) {
        assetRequests.push(new URL(request.url).pathname);
        return new Response("<!doctype html><title>Expense</title>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    },
    ...secrets,
  };
  let adminCookie = "";
  const app = {
    db,
    env,
    assetRequests,
    async request(method, path, { body, admin = false, headers = {} } = {}) {
      const response = await worker.fetch(new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(method === "GET" || method === "HEAD" ? {} : { origin: ORIGIN }),
          ...(admin ? { cookie: adminCookie } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      }), env);
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      return { status: response.status, data, headers: response.headers };
    },
    async login() {
      const response = await app.request("POST", "/api/admin/login", {
        body: { username: secrets.ADMIN_USERNAME, password: secrets.ADMIN_PASSWORD },
      });
      assert.equal(response.status, 200);
      adminCookie = response.headers.get("set-cookie").split(";")[0];
      return adminCookie;
    },
    async addMember(name, api = "/api") {
      const response = await app.request("POST", `${api}/members`, { body: { name }, admin: true });
      assert.equal(response.status, 201, JSON.stringify(response.data));
      return response.data.member.id;
    },
    async addExpense(fields = {}, api = "/api") {
      const created = await app.request("POST", `${api}/expenses`, { body: {} });
      assert.equal(created.status, 201, JSON.stringify(created.data));
      const { id } = created.data.expense;
      if (Object.keys(fields).length) {
        const updated = await app.request("PUT", `${api}/expenses/${id}`, { body: fields });
        assert.equal(updated.status, 200, JSON.stringify(updated.data));
      }
      return id;
    },
    async state(api = "/api", admin = false) {
      const response = await app.request("GET", `${api}/state`, { admin });
      assert.equal(response.status, 200);
      return response.data;
    },
    // Creates a ledger as Admin (login first) and returns its API prefix and table prefix. The operations
    // password is needed only by the session's first creation or Store; later ones ignore it.
    async createLedger(name) {
      const response = await app.request("POST", "/api/admin/ledgers", {
        body: { name, password: secrets.HISTORY_RESTORE_PASSWORD }, admin: true,
      });
      assert.equal(response.status, 201, JSON.stringify(response.data));
      const { id, slug } = response.data.ledger;
      return { id, slug, api: `/api/g/${slug}`, prefix: `ledger_${id}_` };
    },
    count(sql, ...values) {
      return app.db.rows(sql, ...values)[0].count;
    },
  };
  return app;
}

export function signedCookie(details, secret = SECRETS.ADMIN_SESSION_SECRET) {
  const payload = Buffer.from(JSON.stringify(details)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `admin_session=${payload}.${signature}`;
}
