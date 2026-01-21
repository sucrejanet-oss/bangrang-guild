export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const { token, id, path } = body;

  if (!token || token !== process.env.ADMIN_TOKEN) return json(401, { error: "Unauthorized" });
  if (!id || !path) return json(400, { error: "Missing id/path" });

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return json(500, { error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" });

  const dbRes = await fetch(`${url}/rest/v1/photo_posts?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal"
    }
  });
  if (!dbRes.ok) {
    const t = await dbRes.text();
    return json(dbRes.status, { error: "DB delete failed", details: t });
  }

  const stRes = await fetch(`${url}/storage/v1/object/bangrang-photos/${encodeURIComponent(path)}`, {
    method: "DELETE",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
  });
  if (!stRes.ok) {
    const t = await stRes.text();
    return json(stRes.status, { error: "Storage delete failed", details: t });
  }

  return json(200, { ok: true });
}

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(obj) };
}
