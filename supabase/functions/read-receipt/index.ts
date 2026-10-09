// 讀收據：把收據照片交給 Claude Haiku，回傳店名、商品、價格、總額（JSON）
// 部署在 Supabase Edge Functions，API 金鑰放在 Secrets（ANTHROPIC_API_KEY），不會出現在網頁裡。

const ALLOWED_ORIGINS = ["https://creamy-lab.github.io"];
const MODEL = "claude-haiku-5-5";

const PROMPT = `You are reading a shopping receipt photographed by a traveller.
Return ONLY one JSON object, no other text:
{"store": brand or shop name (read the logo or header, e.g. "Goyard", "Louis Vuitton", "Loewe"),
 "city": city printed on the receipt or null,
 "country": country in English or null,
 "date": "YYYY-MM-DD" or null,
 "currency": ISO code such as "EUR" or "KRW",
 "items": [{"name": product name as printed, "price": final price for that line incl. tax, as a number}],
 "total": total paid incl. tax, as a number}
Use a dot as the decimal separator. Leave out tax lines, discounts and payment lines from items.
If something is unreadable use null. Never invent items.`;

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  const headers = { ...corsHeaders(origin), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers });
  }
  try {
    const { image } = await req.json();
    if (typeof image !== "string" || image.length < 100 || image.length > 6_000_000) {
      throw new Error("invalid image");
    }
    // 去掉不小心貼進去的空白、引號、隱形字元，只留下金鑰本身
    const apiKey = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").replace(/[^\x21-\x7E]/g, "").replace(/["'`]/g, "");
    if (!apiKey.startsWith("sk-ant-")) {
      throw new Error("ANTHROPIC_API_KEY 看起來不對：請在 Supabase Secrets 重新貼上以 sk-ant- 開頭的金鑰");
    }
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
            { type: "text", text: PROMPT },
          ],
        }],
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message ?? `Claude API ${r.status}`);
    const text = (j.content ?? []).find((c: { type: string }) => c.type === "text")?.text ?? "";
    const m = text.match(/\{[\s\S]*\}/);
    const data = m ? JSON.parse(m[0]) : {};
    return new Response(JSON.stringify(data), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e) }), { status: 500, headers });
  }
});
