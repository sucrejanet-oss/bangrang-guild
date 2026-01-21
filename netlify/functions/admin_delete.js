// /.netlify/functions/admin_delete.js
// 운영진 삭제: Storage 파일 + DB row 삭제
// ✅ path가 URL이거나(bucket 포함) 이상하게 들어와도 자동 정규화해서 삭제합니다.
const { createClient } = require("@supabase/supabase-js");

function normalizePath(input, bucketName) {
  if (!input) return "";
  let p = String(input).trim();

  // If full URL, extract the part after /public/<bucket>/
  if (p.startsWith("http://") || p.startsWith("https://")) {
    const re = new RegExp(`/public/${bucketName}/(.+)$`);
    const m = p.match(re);
    if (m && m[1]) p = m[1];

    // Some URLs might be signed or different shape: .../<bucket>/<path>?...
    const re2 = new RegExp(`/${bucketName}/(.+)$`);
    const m2 = p.match(re2);
    if (m2 && m2[1]) p = m2[1];
  }

  // Strip querystring if present
  if (p.includes("?")) p = p.split("?")[0];

  // Decode URI components safely
  try { p = decodeURIComponent(p); } catch (e) {}

  // Remove leading slashes
  p = p.replace(/^\/+/, "");

  // If someone stored "bucket/path" in DB, strip bucket prefix
  const prefix = bucketName.replace(/\/+$/, "") + "/";
  if (p.startsWith(prefix)) p = p.slice(prefix.length);

  return p;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
    }

    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_TOKEN } = process.env;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const { token, id, path: rawPath } = body;

    if (!token || token !== ADMIN_TOKEN) {
      return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
    }
    if (!id || !rawPath) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing id or path" }) };
    }

    const BUCKET = "bangrang-photos";
    const TABLE = "photo_posts";

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const path = normalizePath(rawPath, BUCKET);

    // 1) Storage 파일 삭제
    const { data: delData, error: delErr } = await supabase.storage.from(BUCKET).remove([path]);
    if (delErr) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Storage delete failed",
          details: delErr,
          debug: { bucket: BUCKET, rawPath, normalizedPath: path, delData },
        }),
      };
    }

    // 2) DB row 삭제
    const { error: dbErr } = await supabase.from(TABLE).delete().eq("id", id);
    if (dbErr) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "DB delete failed", details: dbErr }),
      };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: "Server error", details: String(e) }) };
  }
};
