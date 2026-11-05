import { GoogleGenAI, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import { z } from "zod";
import type { AiProvider, AssistantAnswer, AssistantTool, ExtractedDocument } from "./types.js";

// ---------------------------------------------------------------- shared

const Amount = z.string().nullable();
/** Validates what any reader returns, so a model can never hand the app a malformed draft. */
export const ExtractionSchema = z.object({
  docType: z.enum(["supplier_invoice", "freight_invoice", "customs_entry", "credit_note", "other"]),
  supplierName: z.string().nullable(),
  supplierVatNumber: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  currency: z.string().nullable(),
  purchaseOrderRef: z.string().nullable(),
  containerRef: z.string().nullable(),
  mrn: z.string().nullable(),
  lines: z.array(z.object({
    description: z.string(), quantity: Amount, unitPrice: Amount, net: z.string(), vatRate: Amount, sku: z.string().nullable(),
  })),
  net: Amount, vat: Amount, total: Amount,
  confidence: z.number().min(0).max(1),
  notes: z.array(z.string()),
});

/** The same schema as JSON Schema, for the model's structured output. */
const nullableString = { type: ["string", "null"] };
export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    docType: { type: "string", enum: ["supplier_invoice", "freight_invoice", "customs_entry", "credit_note", "other"] },
    supplierName: nullableString, supplierVatNumber: { ...nullableString, description: "UK VAT number digits only, no GB prefix" },
    invoiceNumber: nullableString,
    invoiceDate: { ...nullableString, description: "YYYY-MM-DD" }, dueDate: { ...nullableString, description: "YYYY-MM-DD" },
    currency: { ...nullableString, description: "ISO 4217 code, e.g. GBP, USD" },
    purchaseOrderRef: { ...nullableString, description: "The buyer's purchase order number if printed, e.g. PO-00012" },
    containerRef: { ...nullableString, description: "Shipping container or bill of lading number" },
    mrn: { ...nullableString, description: "Customs Movement Reference Number" },
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" }, quantity: nullableString, unitPrice: nullableString,
          net: { type: "string", description: "Line amount before VAT, 2 decimals" },
          vatRate: { ...nullableString, description: "Percentage as printed, e.g. 20, 0, or null if not shown" },
          sku: nullableString,
        },
        required: ["description", "quantity", "unitPrice", "net", "vatRate", "sku"],
      },
    },
    net: nullableString, vat: nullableString, total: nullableString,
    confidence: { type: "number", description: "0 to 1: how sure you are that every field is read correctly" },
    notes: { type: "array", items: { type: "string" }, description: "Anything a bookkeeper should check" },
  },
  required: ["docType", "supplierName", "supplierVatNumber", "invoiceNumber", "invoiceDate", "dueDate", "currency",
    "purchaseOrderRef", "containerRef", "mrn", "lines", "net", "vat", "total", "confidence", "notes"],
};

const money2 = (s: string | undefined | null) => {
  if (!s) return null;
  const n = Number(s.replace(/[£$€¥,\s]/g, "").replace(/^\((.*)\)$/, "-$1"));
  return Number.isFinite(n) ? n.toFixed(2) : null;
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export function parseLooseDate(s: string | undefined | null): string | null {
  if (!s) return null;
  const t = s.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(t);
  if (m) return `${m[3]!.length === 2 ? `20${m[3]}` : m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/.exec(t);
  if (m) {
    const mi = MONTHS.indexOf(m[2]!.toLowerCase());
    if (mi >= 0) return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  }
  m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(t);
  if (m) {
    const mi = MONTHS.indexOf(m[1]!.toLowerCase());
    if (mi >= 0) return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  }
  return null;
}

// ---------------------------------------------------------------- demo reader (rules, no model)

/**
 * Reads plain-text invoices the way a careful junior bookkeeper would: label-value pairs, a line table and
 * the totals block. Good enough for the demo and for well-formatted supplier emails; scanned PDFs need the model.
 */
export function rulesExtract(text: string): ExtractedDocument {
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.trim());
  const body = lines.join("\n");
  const notes: string[] = [];
  const find = (re: RegExp) => re.exec(body)?.[1]?.trim() ?? null;
  const label = (names: string) => find(new RegExp(`(?:^|\\n)\\s*(?:${names})\\s*[:#]?\\s*([^\\n]+)`, "i"));

  const supplierName = lines.find((l) => l && !/invoice|tax|^page|^date/i.test(l)) ?? null;
  const vatRaw = find(/VAT\s*(?:Reg(?:istration)?\.?\s*)?(?:No\.?|Number)?\s*[:#]?\s*(GB\s?[\d\s]{9,14})/i);
  const invoiceNumber = label("Invoice\\s*(?:No\\.?|Number|#)|Inv\\s*No\\.?|Credit\\s*Note\\s*(?:No\\.?|Number)");
  const invoiceDate = parseLooseDate(label("Invoice\\s*Date|Date\\s*of\\s*Issue|Tax\\s*Point|Date"));
  const dueDate = parseLooseDate(label("Due\\s*Date|Payment\\s*Due|Due"));
  const po = find(/\b(PO-\d{3,6})\b/i)?.toUpperCase() ?? label("(?:Your\\s*)?(?:PO|Purchase\\s*Order)(?:\\s*(?:No\\.?|Ref(?:erence)?))?");
  const container = find(/\b([A-Z]{4}\d{7})\b/);
  const mrn = find(/\b(\d{2}GB[A-Z0-9]{14})\b/i)?.toUpperCase() ?? null;
  const usd = /\bUSD\b|US\$|\$/.test(body);
  const eur = /\bEUR\b|€/.test(body);
  const currency = usd ? "USD" : eur ? "EUR" : "GBP";

  const isCredit = /credit\s*note/i.test(body);
  const isCustoms = /\b(C88|customs\s+entry|import\s+declaration|CDS)\b/i.test(body) || (mrn !== null && /duty/i.test(body) && !/freight/i.test(body));
  const isFreight = /\b(freight|haulage|shipping|forwarding|THC|demurrage|bill of lading)\b/i.test(body);
  const docType = isCredit ? "credit_note" : isCustoms ? "customs_entry" : isFreight ? "freight_invoice" : invoiceNumber ? "supplier_invoice" : "other";

  // Line table: text, then numbers; the last number on the row is the line amount.
  const items: ExtractedDocument["lines"] = [];
  const num = String.raw`-?[£$€]?\(?[\d,]+(?:\.\d{1,4})?\)?`;
  const row = new RegExp(String.raw`^(?:([A-Z0-9][A-Z0-9-]{2,})\s+)?(.+?)\s{2,}(?:(${num})\s+)?(?:(${num})\s+)?(?:(\d{1,2}(?:\.\d)?)%\s+)?(${num})$`);
  for (const l of lines) {
    if (!l || /^(sub\s*total|net|total|vat|amount due|balance|grand total|page)\b/i.test(l)) continue;
    const m = row.exec(l);
    if (!m || /date|invoice|due|vat reg|account|sort code|iban/i.test(m[2]!)) continue;
    const net = money2(m[6]);
    if (!net || Number(net) === 0) continue;
    const quantity = m[3] && m[4] ? money2(m[3]) : null;
    const unitPrice = m[3] && m[4] ? m[4].replace(/[£$€,]/g, "") : null;
    items.push({ description: m[2]!.trim(), quantity, unitPrice, net, vatRate: m[5] ?? null, sku: m[1] ?? null });
  }

  const net = money2(label("Sub\\s*total|Net\\s*(?:total|amount)?|Total\\s*net"));
  const vat = money2(find(/(?:^|\n)\s*VAT(?:\s*@?\s*\d{1,2}%)?(?:\s*\(\d{1,2}%\))?\s*[:]?\s*([£$€]?[\d,]+\.\d{2})/i));
  const total = money2(label("Total\\s*(?:due|payable|amount)?|Amount\\s*due|Balance\\s*due|Grand\\s*total|Invoice\\s*total"));

  const sumLines = items.reduce((s, l) => s + Number(l.net), 0);
  if (net && items.length && Math.abs(sumLines - Number(net)) > 0.01) notes.push(`The lines add up to ${sumLines.toFixed(2)} but the invoice says ${net} net.`);
  if (net && vat && total && Math.abs(Number(net) + Number(vat) - Number(total)) > 0.01) notes.push("Net plus VAT does not equal the total printed.");
  if (vatRaw && !/^GB\s?\d/.test(vatRaw)) notes.push("Supplier VAT number looks unusual.");
  if (!invoiceNumber) notes.push("No invoice number found.");
  if (!invoiceDate) notes.push("No invoice date found.");

  const found = [supplierName, invoiceNumber, invoiceDate, total ?? net].filter(Boolean).length + (items.length ? 1 : 0);
  return {
    docType, supplierName, supplierVatNumber: vatRaw ? vatRaw.replace(/^GB/i, "").replace(/\s/g, "") : null,
    invoiceNumber, invoiceDate, dueDate, currency, purchaseOrderRef: po, containerRef: container, mrn,
    lines: items, net: net ?? (items.length ? sumLines.toFixed(2) : null), vat, total,
    confidence: Math.round((found / 5) * (notes.length ? 0.85 : 1) * 100) / 100,
    notes,
  };
}

export function demoAi(): AiProvider {
  return {
    info: () => ({ mode: "demo", name: "Built-in rules (no AI model)", ready: true, model: null }),
    async extract(doc) {
      if (doc.isBase64) {
        return { ...emptyExtraction(["The demo reader only reads text files. Set GEMINI_API_KEY to read PDFs and photos."]), model: null };
      }
      return { ...rulesExtract(doc.content), model: null };
    },
    async ask(question, _context, tools) {
      const chosen = tools.filter((t) => t.keywords.test(question)).slice(0, 2);
      if (!chosen.length) {
        return { answer: `I can answer questions about ${tools.map((t) => t.description.split(":")[0]!.toLowerCase()).join("; ")}. Try "Which products make the best margin?" or "When is cash tightest?"`, toolsUsed: [], model: null };
      }
      const parts: string[] = [];
      for (const t of chosen) parts.push(t.summarise(await t.run({})));
      return { answer: parts.join("\n\n"), toolsUsed: chosen.map((t) => ({ name: t.name, args: {} })), model: null };
    },
  };
}

function emptyExtraction(notes: string[]): ExtractedDocument {
  return { docType: "other", supplierName: null, supplierVatNumber: null, invoiceNumber: null, invoiceDate: null, dueDate: null,
    currency: null, purchaseOrderRef: null, containerRef: null, mrn: null, lines: [], net: null, vat: null, total: null, confidence: 0, notes };
}

// ---------------------------------------------------------------- Gemini

const EXTRACT_PROMPT = `You read purchase documents for a UK importer's bookkeeping system.
Return the fields exactly as printed. Do not calculate or guess values that are not on the document: use null.
Amounts are plain numbers with two decimals and no currency symbol. Dates are YYYY-MM-DD; UK documents write dates day first.
Classify freight forwarder, haulier and shipping line invoices as freight_invoice, customs broker or C88/CDS entries as customs_entry.
List anything a bookkeeper should check in notes (totals that do not add up, a missing VAT number on a UK invoice, a foreign currency).`;

const ASK_PROMPT = (company: string, today: string) => `You are the analyst inside Softilo ERP for ${company}, a UK importer and wholesaler. Today is ${today}.
Answer the user's question using only figures returned by the tools. Call the tools you need; never invent numbers.
Amounts are in pounds sterling unless a currency is named. Be brief and specific: lead with the answer, then the two or three figures that support it, and say what to do next if there is an obvious action.
You can only read data. If the user asks you to post, pay, send or change anything, tell them which screen does it.`;

export function geminiAi(env: NodeJS.ProcessEnv = process.env): AiProvider {
  const apiKey = env.GEMINI_API_KEY;
  // The API expects lower-case model names (gemini-3.5-flash-lite); accept them written either way.
  const model = (env.GEMINI_MODEL ?? "gemini-3.5-flash-lite").trim().toLowerCase();
  const client = apiKey ? new GoogleGenAI({ apiKey }) : null;
  const need = apiKey ? [] : ["GEMINI_API_KEY"];
  const ready = () => {
    if (!client) throw Object.assign(new Error("AI is set to live but GEMINI_API_KEY is not set"), { statusCode: 503 });
    return client;
  };

  return {
    info: () => ({ mode: "live", name: "Google Gemini", ready: !need.length, missing: need, model }),

    async extract(doc) {
      const ai = ready();
      const part: Part = doc.isBase64
        ? { inlineData: { mimeType: doc.mediaType, data: doc.content } }
        : { text: `File name: ${doc.filename}\n\n${doc.content}` };
      const res = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [part, { text: "Extract this document." }] }],
        config: { systemInstruction: EXTRACT_PROMPT, responseMimeType: "application/json", responseJsonSchema: EXTRACTION_JSON_SCHEMA, temperature: 0 },
      });
      let parsed: unknown;
      try { parsed = JSON.parse(res.text ?? ""); } catch { throw Object.assign(new Error("The AI reader returned something that is not JSON"), { statusCode: 502 }); }
      const out = ExtractionSchema.safeParse(parsed);
      if (!out.success) throw Object.assign(new Error(`The AI reader's answer did not match the expected fields: ${out.error.issues[0]?.message}`), { statusCode: 502 });
      return { ...out.data, model, inputTokens: res.usageMetadata?.promptTokenCount, outputTokens: res.usageMetadata?.candidatesTokenCount };
    },

    async ask(question, context, tools): Promise<AssistantAnswer> {
      const ai = ready();
      const declarations: FunctionDeclaration[] = tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters }));
      const contents: Content[] = [{ role: "user", parts: [{ text: question }] }];
      const used: AssistantAnswer["toolsUsed"] = [];
      let input = 0;
      let output = 0;
      for (let turn = 0; turn < 6; turn++) {
        const res = await ai.models.generateContent({
          model, contents,
          config: { systemInstruction: ASK_PROMPT(context.company, context.today), tools: [{ functionDeclarations: declarations }], temperature: 0.2 },
        });
        input += res.usageMetadata?.promptTokenCount ?? 0;
        output += res.usageMetadata?.candidatesTokenCount ?? 0;
        const calls = res.functionCalls ?? [];
        const modelContent = res.candidates?.[0]?.content;
        if (!calls.length) return { answer: res.text?.trim() || "I couldn't find an answer to that.", toolsUsed: used, model, inputTokens: input, outputTokens: output };
        if (modelContent) contents.push(modelContent);
        const responses: Part[] = [];
        for (const call of calls) {
          const tool = tools.find((t) => t.name === call.name);
          const args = (call.args ?? {}) as Record<string, unknown>;
          used.push({ name: call.name ?? "unknown", args });
          let result: unknown;
          try { result = tool ? await tool.run(args) : { error: `No tool called ${call.name}` }; } catch (e) { result = { error: (e as Error).message }; }
          responses.push({ functionResponse: { id: call.id, name: call.name, response: { result } } });
        }
        contents.push({ role: "user", parts: responses });
      }
      return { answer: "That question needed more steps than I allow. Try asking something narrower.", toolsUsed: used, model, inputTokens: input, outputTokens: output };
    },
  };
}
