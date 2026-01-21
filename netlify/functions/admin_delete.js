// /.netlify/functions/admin_delete.js
const { createClient } = require("@supabase/supabase-js");

function normalizePath(input, bucketName) {
  if (!input) return "";
  let p = String(input).trim();

  if (p.startsWith("http://") || p.startsWith("https://")) {
    const re = new RegExp(`/public/${bucketName}/(.+)$`);
    const m = p.match(re);
    if (m && m[1]) p = m[1];

    const re2 = new RegExp(`/${bucketName}/(.+)$`);
    const m2 = p.match(re2);
    if (m2 && m2[1]) p = m2[1];
  }

  if (p.includes("?")) p = p.split("?")[0];

  try { p = decodeURIComponent(p); } catch (e) {}

  p = p.replace(/^\/+/, "");

  const prefix = bucketName.replace(/\/+$/, "") + "/";
  if (p.startsWith(prefix)) p = p.slice(prefix.length);

  return p;
}

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

    let body = {};
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { error: "Invalid JSON body", rawBody: event.body || "" }); }

    const token = body?.token;
    const incomingId = body?.id;   // 지금은 uuid 형태
    const rawPath = body?.path;

    if (!token || token !== ADMIN_TOKEN) {
      return json(401, { error: "Unauthorized" });
    }

    const idMissing = (incomingId === undefined || incomingId === null || String(incomingId).trim() === "");
    const pathMissing = (rawPath === undefined || rawPath === null || String(rawPath).trim() === "");
    if (idMissing || pathMissing) {
      return json(400, { error: "Missing id or path", debug: { got_id: incomingId, got_path: rawPath } });
    }

    const BUCKET = "bangrang-photos";
    const TABLE  = "photo_posts";

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // 0) 먼저 row 확인 (삭제 대상 존재 여부)
    const { data: row, error: getErr } = await supabase
      .from(TABLE)
      .select("id,image_path")
      .eq("id", incomingId)
      .maybeSingle();

    if (getErr) {
      return json(500, { error: "DB lookup failed", details: getErr });
    }
    if (!row) {
      return json(404, { error: "Post not found", debug: { incomingId } });
    }

    // 1) Storage 삭제 (DB 경로 우선)
    const normalizedPath = normalizePath(rawPath, BUCKET);
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
        debug: { incomingId, rawPath, normalizedPath, pathFromDb, pathToDelete, delData },
      });
    }

    // 2) DB 삭제 (✅ count로 확실하게 확인)
    const { count, error: dbErr } = await supabase
      .from(TABLE)
      .delete({ count: "exact" })     // ✅ 여기 중요
      .eq("id", incomingId);

    if (dbErr) {
      return json(500, { error: "DB delete failed", details: dbErr, debug: { incomingId } });
    }

    const db_deleted = typeof count === "number" ? count : 0;
    const storage_removed = Array.isArray(delData) ? delData.length : 0;

    // 3) 삭제 0건이면: 진짜 남아있는지 다시 확인
    if (db_deleted === 0) {
      const { data: stillThere, error: chkErr } = await supabase
        .from(TABLE)
        .select("id")
        .eq("id", incomingId)
        .maybeSingle();

      if (chkErr) {
        return json(500, { error: "DB recheck failed", details: chkErr, debug: { incomingId } });
      }

      if (stillThere) {
        // ✅ 이 케이스가 지금 하람에게 발생한 핵심
        return json(403, {
          error: "DB delete blocked (permission/RLS likely)",
          message:
            "조회는 되는데 삭제가 0건이면, Netlify 환경변수의 SUPABASE_SERVICE_ROLE_KEY가 잘못됐거나(RLS/권한) 삭제 정책이 없어 막힌 경우가 많아요.",
          debug: { incomingId, db_deleted, storage_removed },
        });
      }

      // row가 안 보이면(=삭제됐는데 반환만 0으로 나온 경우) 성공 처리
      return json(200, {
        ok: true,
        db_deleted: 1,
        storage_removed,
        deleted_id: incomingId,
        deleted_path: pathToDelete,
        note: "Delete count was 0, but row is gone after recheck (treated as success).",
      });
    }

    return json(200, {
      ok: true,
      db_deleted,
      storage_removed,
      deleted_id: incomingId,
      deleted_path: pathToDelete,
    });

  } catch (e) {
    return json(500, { error: "Server error", details: String(e) });
  }
};
