// 讀收據：把收據照片交給 Claude Haiku，回傳店名、商品、價格、總額、消費類別、是否有退稅字樣（JSON）
// 部署在 Supabase Edge Functions，API 金鑰放在 Secrets（ANTHROPIC_API_KEY），不會出現在網頁裡。

const ALLOWED_ORIGINS = ["https://creamy-lab.github.io"];
const MODEL = "claude-haiku-5-5";

const PROMPT = `You are reading a shopping receipt photographed by a traveller.
Call the "receipt" tool with exactly one object in this format:
{"store": brand or shop name (read the logo or header, e.g. "Goyard", "Louis Vuitton", "Loewe"),
 "city": city printed on the receipt or null,
 "country": country in English or null,
 "date": "YYYY-MM-DD" or null,
 "currency": ISO code of the money actually paid, exactly as on the receipt (e.g. "EUR", "USD", "KRW", "GBP"),
 "items": [{"name": product name as printed,
            "qty": number,
            "net": line amount BEFORE tax, as a number,
            "tax": tax amount for this line, as a number,
            "price": line amount INCLUDING tax, as a number}],
 "card": card used to pay, as card brand plus last 4 digits if printed, e.g. "Visa •1234", "Mastercard •5678", "Visa", or null if paid in cash / not shown,
 "subtotal_net": total before tax or null,
 "tax_total": total tax or null,
 "total": total paid including tax,
 "category": what kind of spending this is, exactly one of "shop" (shopping: fashion, luxury, souvenirs, supermarket goods, pharmacy), "food" (restaurant, café, bar, bakery, food stall), "transport" (taxi, train, metro, bus, fuel, parking, car rental), "ticket" (museum, attraction, show, tour), "hotel" (accommodation), "other",
 "tax_free": true if the receipt shows any sign that a tax-free / VAT refund form was or can be issued (e.g. "Tax Free", "Tax Refund", "Détaxe", "Global Blue", "Planet", "Innova", "DIVA", "PABLO", "VAT refund", "Tax free form", "즉시환급", "사후면세", "退稅"), false if there is no such sign}
Rules:
- If the printed item prices EXCLUDE tax (common in the US), net = printed price, tax = that line's tax, price = net + tax.
- If the printed item prices already INCLUDE tax/VAT/TVA/IVA (common in Europe and Korea), price = printed price;
  take the VAT from the receipt's VAT breakdown and split it across lines in proportion to price if it is only shown in total; net = price - tax.
- Items' price values should add up to total. Leave out tax lines, discounts, deposits and payment lines from items.
- Use a dot as the decimal separator. If something is unreadable use null. Never invent items.`;

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
        max_tokens: 2048,
        tools: [{ name: "receipt", description: "Return the result as structured data, following the JSON format described in the instructions.", input_schema: { type: "object", additionalProperties: true } }],
        tool_choice: { type: "tool", name: "receipt" },
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
    const used = (j.content ?? []).find((c: { type: string }) => c.type === "tool_use") as { input?: unknown } | undefined;
    const text = (j.content ?? []).find((c: { type: string }) => c.type === "text")?.text ?? "";
    const data = used && used.input && typeof used.input === "object" ? used.input : parseLooseJson(text);
    return new Response(JSON.stringify(data), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e) }), { status: 500, headers });
  }
});
