function pickEnv(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v && String(v).trim()) return String(v).trim();
  }
  return "";
}

export async function handler(event) {
  const type = (event.queryStringParameters?.type || "").toLowerCase();

  const token = pickEnv("NOTION_TOKEN", "NORION_TOKEN");
  const NOTICE_DB_ID = pickEnv("NOTICE_DB_ID", "NOTION_NOTICE_DB");
  const TIPS_DB_ID = pickEnv("TIPS_DB_ID", "NOTION_TIPS_DB");
  const PHOTOS_DB_ID = pickEnv("PHOTOS_DB_ID", "NOTION_PHOTO_DB");

  if (!token) return json(500, { error: "Missing NOTION_TOKEN" });

  let databaseId = "";
  if (type === "notice") databaseId = NOTICE_DB_ID;
  else if (type === "tips") databaseId = TIPS_DB_ID;
  else if (type === "photos") databaseId = PHOTOS_DB_ID;
  else return json(400, { error: "Invalid type" });

  if (!databaseId) return json(500, { error: "Missing DB ID" });

  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page_size: 50 }),
    });

    const data = await res.json();
    return json(res.ok ? 200 : res.status, data);
  } catch (e) {
    return json(500, { error: String(e) });
  }
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(obj),
  };
}
