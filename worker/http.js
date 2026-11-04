const MAX_BODY_BYTES = 100_000;
const INVALID_JSON = "Dữ liệu JSON không hợp lệ.";

const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
});

// Same strings as public/_headers (static assets); keep both in sync.
export const PAGE_SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "X-Robots-Tag": "noindex, nofollow",
});

export class ApiError extends Error {
  constructor(message, status, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

export function error(message, status = 400, headers = {}) {
  return json({ error: message }, status, headers);
}

function tooLarge() {
  return new ApiError("Dữ liệu gửi lên quá lớn.", 413);
}

// Content-Length can be absent (chunked uploads), so the streamed size is capped too. A body stream
// that fails (e.g. the client aborted) is invalid JSON, as it was with request.json().
async function readBodyText(request) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read().catch(() => {
      throw new ApiError(INVALID_JSON, 400);
    });
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// allowEmpty: a request without a body reads as {} instead of invalid JSON.
export async function readJson(request, { allowEmpty = false } = {}) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) throw tooLarge();
  const text = await readBodyText(request);
  if (allowEmpty && text === "") return {};
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiError(INVALID_JSON, 400);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("Dữ liệu gửi lên phải là một đối tượng JSON.", 400);
  }
  return body;
}

// Path parameters stay percent-encoded until a handler needs them; a malformed escape means "not found".
export function decodePathParam(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
