// 菜單翻譯：把菜單照片交給 Claude Haiku，翻成台灣繁體中文，依家人口味推薦招牌菜與點菜組合，並標出含牛肉、素食、熱食、辣（JSON）
// 部署在 Supabase Edge Functions，跟 read-receipt 共用同一把 ANTHROPIC_API_KEY（放在 Secrets，不會出現在網頁裡）。

const ALLOWED_ORIGINS = ["https://creamy-lab.github.io"];
const MODEL = "claude-haiku-5-5";

// 家人口味由網頁傳過來（FAMILY_PREFS），之後要改口味只要改網頁，不用重新部署這個功能
const DEFAULT_PREFS = `- Mom and Sherry: no beef in any form.
- Dad: lacto-ovo vegetarian (no meat, poultry, fish, seafood or meat/fish stock; eggs and dairy are fine).
- Everyone: loves hot soup, no spicy food, needs rice or noodles at every meal.`;

function buildPrompt(prefs: string, city: string) {
  return `You are a warm, knowledgeable local food guide helping an elderly Taiwanese family (about 80 years old) order from a restaurant menu abroad. They read ONLY Traditional Chinese as used in Taiwan.
${city ? `They are now in: ${city}.\n` : ""}
FAMILY PREFERENCES (always follow these):
${prefs}
General rules for these preferences:
- "No beef" means beef in any form: beef, veal, ox, oxtail, beef broth/stock/jus, bresaola, cecina, rabo de toro, carrillada de ternera, steak tartare, 소고기/불고기/갈비 etc.
- "Vegetarian" means no meat, poultry, ham, bacon, chorizo, fish, seafood, anchovy, meat/chicken/fish stock, lard or gelatin.

Read every dish and drink on the menu photo and call the "menu" tool with exactly one object in this format:
{"lang": language of the menu in Traditional Chinese, e.g. "西班牙文",
 "currency": ISO code if prices are shown, e.g. "EUR", or null,
 "intro": 2 short sentences in Traditional Chinese: what kind of restaurant/cuisine this is and what this place or region is famous for,
 "famous": up to 3 items ON THIS MENU that are the most famous / signature local dishes or drinks worth trying, each {"orig": exact name as printed, "why": one short sentence in Traditional Chinese},
 "set": a suggested order for this family that follows ALL preferences: every person gets rice or noodles, include a hot soup if the menu has one, nothing spicy, a vegetarian main for Dad, no beef for anyone. Each entry {"who": "爸爸" or "媽媽" or "Sherry" or "大家分享", "orig": exact name as printed, "why": one short sentence in Traditional Chinese, mention any request to tell the waiter (e.g. 請店家不要加火腿)}. If the menu has no rice/noodle or no soup, say so honestly in "tip".
 "items": [{"section": menu section translated to Traditional Chinese (e.g. "前菜", "湯", "主菜", "飯麵", "甜點", "飲料"),
            "orig": dish name exactly as printed,
            "zh": natural Taiwanese Traditional Chinese dish name (short),
            "desc": one short sentence in Traditional Chinese: main ingredients and how it is cooked, in plain words for an 80-year-old,
            "price": price as a number or null,
            "beef": "yes" | "maybe" | "no"  ("maybe" if it commonly contains beef or the menu is unclear, e.g. generic "carne", meatballs, stews, jus, gravy, mixed grill),
            "vegan": "yes" if vegetarian as defined above (eggs and dairy allowed) | "maybe" if it could easily be made vegetarian or might hide stock/ham/anchovy | "no",
            "hot": true if served hot, false if cold or raw, null if unknown,
            "spicy": true if spicy/hot chili, false otherwise,
            "staple": true if it is (or comes with) rice or noodles/pasta}],
 "dad": up to 3 "orig" names that are the best HOT vegetarian choices for Dad, empty list if none,
 "tip": one short friendly sentence in Traditional Chinese with the most useful advice for this meal}
Rules:
- Keep the menu order in "items". Translate every readable item, including drinks and desserts. Never invent dishes that are not on the photo; "famous", "set" and "dad" must only use names that appear in "items".
- Use Taiwanese wording (例如：馬鈴薯、番茄、起司、優格、鮭魚、花枝、鷹嘴豆、橄欖油、燉飯、義大利麵), never Mainland or Hong Kong wording.
- When unsure about beef, vegetarian or spicy status, choose the cautious answer ("maybe" / true).
- If the photo is not a menu or is unreadable, return {"items": [], "tip": "看不清楚菜單，請靠近一點、光線亮一點再拍一次"}.`;
}

// AI 偶爾會回傳格式不完全正確的 JSON（例如多一個逗號），這裡先盡量修好再解析
function parseLooseJson(text: string) {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("AI 沒有回傳結果，請再拍一次");
  let s = text.slice(a, b + 1);
  try { return JSON.parse(s); } catch (_) { /* 修一修再試 */ }
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
       .replace(/\/\/[^\n"]*$/gm, "")
       .replace(/,\s*([}\]])/g, "$1")
       .replace(/\b(NaN|undefined)\b/g, "null")
       .replace(/}\s*{/g, "},{")
       .replace(/"\s*\n\s*"/g, '",\n"')
       .replace(/(\d)\s*\n\s*"/g, '$1,\n"')
       .replace(/(true|false|null)\s*\n\s*"/g, '$1,\n"')
       .replace(/}\s*\n\s*"/g, '},\n"')
       .replace(/]\s*\n\s*"/g, '],\n"');
  return JSON.parse(s);
}

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
    const { image, prefs, city } = await req.json();
    const prefText = typeof prefs === "string" && prefs.trim() ? prefs.slice(0, 2000) : DEFAULT_PREFS;
    const cityText = typeof city === "string" ? city.slice(0, 100) : "";
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
        tools: [{ name: "menu", description: "Return the result as structured data, following the JSON format described in the instructions.", input_schema: { type: "object", additionalProperties: true } }],
        tool_choice: { type: "tool", name: "menu" },
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
            { type: "text", text: buildPrompt(prefText, cityText) },
          ],
        }],
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message ?? `Claude API ${r.status}`);
    const used = (j.content ?? []).find((c: { type: string }) => c.type === "tool_use") as { input?: unknown } | undefined;
    const text = (j.content ?? []).find((c: { type: string }) => c.type === "text")?.text ?? "";
    const data = used && used.input && typeof used.input === "object" ? used.input : parseLooseJson(text);
    return new Response(JSON.stringify(data), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e) }), { status: 500, headers });
  }
});
