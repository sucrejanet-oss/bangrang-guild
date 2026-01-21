// /.netlify/functions/admin_delete.js
// 운영진 삭제: Storage 파일 + DB row 삭제
// ✅ path가 URL이거나(bucket 포함) 이상하게 들어와도 자동 정규화
// ✅ "삭제 0건"인 경우도 에러로 알려서(겉으로만 성공) 문제를 잡기 쉽게 함
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
      return { statusCode: 500, body: JSON.stringify({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }) };
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

    const normalizedPath = normalizePath(rawPath, BUCKET);

    // 0) 먼저 DB에서 존재 확인 (경로도 같이 확인 가능)
    const { data: row, error: getErr } = await supabase
      .from(TABLE)
      .select("id,image_path")
      .eq("id", id)
      .maybeSingle();

    if (getErr) {
      return { statusCode: 500, body: JSON.stringify({ error: "DB lookup failed", details: getErr }) };
    }
    if (!row) {
      // 겉으로 성공처럼 보이는 문제를 방지
      return { statusCode: 404, body: JSON.stringify({ error: "Post not found", db_deleted: 0 }) };
    }

    // 1) Storage 파일 삭제 (DB에 있는 경로 우선)
    const pathFromDb = row.image_path ? normalizePath(row.image_path, BUCKET) : "";
    const pathToDelete = pathFromDb || normalizedPath;

    const { data: delData, error: delErr } = await supabase.storage.from(BUCKET).remove([pathToDelete]);
    if (delErr) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Storage delete failed",
          details: delErr,
          debug: { bucket: BUCKET, id, rawPath, normalizedPath, pathFromDb, pathToDelete, delData },
        }),
      };
    }

    // 2) DB row 삭제 + 삭제된 행 반환(확실히 지워졌는지)
    const { data: deletedRows, error: dbErr } = await supabase
      .from(TABLE)
      .delete()
      .eq("id", id)
      .select("id");

    if (dbErr) {
      return { statusCode: 500, body: JSON.stringify({ error: "DB delete failed", details: dbErr }) };
    }

    const db_deleted = Array.isArray(deletedRows) ? deletedRows.length : 0;
    const storage_removed = Array.isArray(delData) ? delData.length : 0;

    if (db_deleted === 0) {
      // 이 경우는 거의 없지만, 혹시 모를 문제를 잡기 위해
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "DB delete returned 0 rows", db_deleted, storage_removed }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, db_deleted, storage_removed, deleted_id: id, deleted_path: pathToDelete }),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: "Server error", details: String(e) }) };
  }
};
