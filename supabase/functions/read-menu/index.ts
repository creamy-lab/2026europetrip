// 菜單翻譯：把菜單照片交給 Claude Haiku，翻成台灣繁體中文，並標出含牛肉、素食（蛋奶素）、熱食（JSON）
// 部署在 Supabase Edge Functions，跟 read-receipt 共用同一把 ANTHROPIC_API_KEY（放在 Secrets，不會出現在網頁裡）。

const ALLOWED_ORIGINS = ["https://creamy-lab.github.io"];
const MODEL = "claude-haiku-5-5";

const PROMPT = `You are helping an elderly Taiwanese family read a restaurant menu abroad. They read ONLY Traditional Chinese as used in Taiwan.
Family diet:
- NOBODY eats beef in any form: beef, veal, ox, oxtail, beef broth/stock/jus, beef fat, bresaola, cecina, rabo de toro, carrillada de ternera, steak tartare, carpaccio de ternera, 소고기/불고기/갈비 etc.
- Dad is lacto-ovo vegetarian (蛋奶素): NO meat, poultry, ham, bacon, fish, seafood, anchovy, meat/chicken/fish stock, lard or gelatin; eggs, milk, cheese, butter and yogurt are FINE. He prefers HOT dishes (soup, rice, stews, omelettes, cooked vegetables), not cold salads or raw food.

Read every dish and drink on the menu photo and return ONLY one JSON object, no other text:
{"lang": language of the menu in Traditional Chinese, e.g. "西班牙文",
 "currency": ISO code if prices are shown, e.g. "EUR", or null,
 "items": [{"section": menu section translated to Traditional Chinese (e.g. "前菜", "主菜", "甜點", "飲料"),
            "orig": dish name exactly as printed,
            "zh": natural Taiwanese Traditional Chinese dish name (short, what a Taiwanese menu would say),
            "desc": one short sentence in Traditional Chinese: main ingredients and how it is cooked, in plain words for an 80-year-old,
            "price": price as a number or null,
            "beef": "yes" if it contains beef/veal/beef stock, "maybe" if it commonly does or the menu is unclear (e.g. generic "carne", meatballs, stews, "jus", gravy, mixed grill), "no" otherwise,
            "vegan": "yes" if it is lacto-ovo vegetarian as described for Dad (eggs and dairy allowed), "maybe" if it could easily be made vegetarian (e.g. ask to remove the ham) or might hide meat/fish stock, ham bits or anchovies, "no" otherwise,
            "hot": true if served hot, false if cold or raw, null if unknown}],
 "dad": up to 3 "orig" names that are the best HOT lacto-ovo vegetarian choices for Dad (e.g. tortilla de patatas, pisto, vegetable rice, cheese or egg dishes), empty list if none,
 "tip": one short friendly sentence in Traditional Chinese with the most useful advice for this menu (e.g. which local specialty to try, or what to ask the waiter)}
Rules:
- Keep the menu order. Translate every readable item, including drinks and desserts. Never invent dishes that are not on the photo.
- Use Taiwanese wording (例如：馬鈴薯、番茄、起司、優格、鮭魚、花枝、鷹嘴豆、橄欖油、燉飯), never Mainland or Hong Kong wording.
- When unsure about beef or vegetarian status, choose "maybe", never "no" or "yes".
- If the photo is not a menu or is unreadable, return {"items": [], "tip": "看不清楚菜單，請靠近一點、光線亮一點再拍一次"}.`;

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
    if (typeof image !== "string" || image.length < 100 || image.length > 8_000_000) {
      throw new Error("invalid image");
    }
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
        max_tokens: 8000,
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
    if (!m) throw new Error("AI 沒有回傳結果，請再拍一次");
    return new Response(m[0], { headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e) }), { status: 500, headers });
  }
});
