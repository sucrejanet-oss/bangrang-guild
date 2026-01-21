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
    const incomingId = body?.id;      // 프론트에서 넘어온 값(지금은 uuid처럼 보임)
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
    const TABLE = "photo_posts";

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const normalizedPath = normalizePath(rawPath, BUCKET);

    // ✅ 0) DB row 찾기: (1) id로 찾아보고, (2) 안 되면 uuid 계열 컬럼들로도 찾아봄
    //    찾은 row의 "진짜 PK(id)" 값을 finalDeleteId로 사용한다.
    let row = null;
    let findMode = "id";

    // 0-1) 우선 id로 조회 (일반적인 PK)
    {
      const { data, error } = await supabase
        .from(TABLE)
        .select("id,image_path")
        .eq("id", incomingId)
        .maybeSingle();

      if (error) return json(500, { error: "DB lookup failed", details: error, debug: { step: "lookup_by_id" } });
      row = data || null;
    }

    // 0-2) 못 찾으면 uuid 가능성 컬럼들로 재시도
    // (테이블에 따라 컬럼명이 다를 수 있어서 흔한 이름들을 순서대로 시도)
    const altCols = ["uuid", "post_uuid", "post_id", "uid"];
    if (!row) {
      for (const col of altCols) {
        const { data, error } = await supabase
          .from(TABLE)
          .select("id,image_path")
          .eq(col, incomingId)
          .maybeSingle();

        // 컬럼이 없으면 에러가 날 수 있는데, 그건 그냥 다음 컬럼을 시도
        if (error) {
          // "column does not exist" 류는 무시하고 다음으로
          continue;
        }
        if (data) {
          row = data;
          findMode = col;
          break;
        }
      }
    }

    if (!row) {
      return json(404, { error: "Post not found", debug: { incomingId } });
    }

    const finalDeleteId = row.id; // ✅ DB에서 실제로 삭제할 PK

    // ✅ 1) Storage 삭제 (DB 경로 우선)
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
        debug: { bucket: BUCKET, incomingId, findMode, finalDeleteId, rawPath, normalizedPath, pathFromDb, pathToDelete, delData },
      });
    }

    // ✅ 2) DB 삭제는 무조건 PK(id)로 진행
    const { data: deletedRows, error: dbErr } = await supabase
      .from(TABLE)
      .delete()
      .eq("id", finalDeleteId)
      .select("id");

    if (dbErr) {
      return json(500, { error: "DB delete failed", details: dbErr, debug: { finalDeleteId } });
    }

    const db_deleted = Array.isArray(deletedRows) ? deletedRows.length : 0;
    const storage_removed = Array.isArray(delData) ? delData.length : 0;

    if (db_deleted === 0) {
      return json(500, {
        error: "DB delete returned 0 rows",
        db_deleted,
        storage_removed,
        debug: { incomingId, findMode, finalDeleteId },
      });
    }

    return json(200, {
      ok: true,
      db_deleted,
      storage_removed,
      deleted_id: finalDeleteId,
      deleted_path: pathToDelete,
      debug: { incomingId, findMode },
    });
  } catch (e) {
    return json(500, { error: "Server error", details: String(e) });
  }
};
