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
    const id = body?.id;
    const rawPath = body?.path;

    if (!token || token !== ADMIN_TOKEN) {
      return json(401, { error: "Unauthorized" });
    }

    const idMissing = (id === undefined || id === null || String(id).trim() === "");
    const pathMissing = (rawPath === undefined || rawPath === null || String(rawPath).trim() === "");
    if (idMissing || pathMissing) {
      return json(400, { error: "Missing id or path", debug: { got_id: id, got_path: rawPath } });
    }

    const BUCKET = "bangrang-photos";
    const TABLE = "photo_posts";

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const normalizedPath = normalizePath(rawPath, BUCKET);

    // 0) DB에서 존재 확인
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

    // 1) Storage 파일 삭제 (DB 경로 우선)
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

    // 2) DB row 삭제
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

    return json(200, { ok: true, db_deleted, storage_removed, deleted_id: id, deleted_path: pathToDelete });
  } catch (e) {
    return json(500, { error: "Server error", details: String(e) });
  }
};
