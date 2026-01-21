// /.netlify/functions/admin_delete.js
// 운영진 삭제: Storage 파일 + DB row 삭제
// ✅ path가 URL이거나(bucket 포함) 이상하게 들어와도 자동 정규화
// ✅ "삭제 0건"인 경우도 에러로 알려서(겉으로만 성공) 문제를 잡기 쉽게 함
// ✅ 400 Bad Request( id/path 누락 ) 원인을 화면에서 바로 알 수 있도록 debug 포함
// ✅ DevTools에서 "failed to load response data" 줄이기 위해 응답 헤더/CORS 추가

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

// ✅ 모든 응답에 공통으로 헤더를 넣어주는 헬퍼
function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(obj),
  };
}

exports.handler = async (event) => {
  // ✅ preflight 대응 (브라우저가 먼저 OPTIONS를 보낼 때가 있음)
  if (event.httpMethod === "OPTIONS") {
    return json(200, { ok: true });
  }

  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_TOKEN } = process.env;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json(500, { error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" });
    }

    // ✅ body 파싱을 안전하게
    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      return json(400, { error: "Invalid JSON body", rawBody: event.body || "" });
    }

    const token = body?.token;
    const id = body?.id;
    const rawPath = body?.path;

    if (!token || token !== ADMIN_TOKEN) {
      return json(401, { error: "Unauthorized" });
    }

    // ✅ 기존의 (!id || !rawPath) 대신 "진짜로 비었을 때만" 400
    const idMissing = (id === undefined || id === null || String(id).trim() === "");
    const pathMissing = (rawPath === undefined || rawPath === null || String(rawPath).trim() === "");

    if (idMissing || pathMissing) {
      return json(400, {
        error: "Missing id or path",
        debug: { got_id: id, got_path: rawPath },
      });
    }

    const BUCKET = "bangrang-photos";
    const TABLE = "photo_posts";

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const normalizedPath = normalizePath(rawPath, BUCKET);

    // 0) 먼저 DB에서 존재 확인
    const { data: row, error: getErr } = await supabase
      .from(TABLE)
      .select("id,image_path")
      .eq("id", id)
      .maybeSingle();

    if (getErr) {
      return json(500, { error: "DB lookup failed", details: getErr });
    }
    if (!row) {
      return json(404, { error: "Post not found", db_deleted: 0, debug: { id } });
    }

    // 1) Storage 파일 삭제 (DB에 있는 경로 우선)
    const pathFromDb = row.image_path ? normalizePath(row.image_path, BUCKET) : "";
    const pathToDelete = pathFromDb || normalizedPath;

    const { data: delData, error: delErr } = await supabase
      .storage
      .from(BUCKET)
      .remove([pathToDelete]);

    if (delErr) {
      return json(500, {
        error: "Storage delete failed",
        details: delErr,
        debug: { bucket: BUCKET, id, rawPath, normalizedPath, pathFromDb, pathToDelete, delData },
      });
    }

    // 2) DB row 삭제 + 삭제된 행 반환
    const { data: deletedRows, error: dbErr } = await supabase
      .from(TABLE)
      .delete()
      .eq("id", id)
      .select("id");

    if (dbErr) {
      return json(500, { error: "DB delete failed", details: dbErr });
    }

    const db_deleted = Array.isArray(deletedRows) ? deletedRows.length : 0;
    const storage_removed = Array.isArray(delData) ? delData.length : 0;

    if (db_deleted === 0) {
      return json(500, { error: "DB delete returned 0 rows", db_deleted, storage_removed, debug: { id } });
    }

    return json(200, {
      ok: true,
      db_deleted,
      storage_removed,
      deleted_id: id,
      deleted_path: pathToDelete,
    });
  } catch (e) {
    return json(500, { error: "Server error", details: String(e) });
  }
};
