import * as cheerio from "cheerio";

export function htmlToText(html: string): string {
  // Greenhouse returns HTML-escaped HTML; unescape first.
  const unescaped = /&lt;\w/.test(html) ? cheerio.load(`<x>${html}</x>`)("x").text() : html;
  const $ = cheerio.load(unescaped);
  $("script,style").remove();
  $("br").replaceWith("\n");
  $("p,li,h1,h2,h3,h4,div").each((_, el) => {
    $(el).append("\n");
  });
  return $.root()
    .text()
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

const STOP = new Set(
  "a an and are as at be by for from has have in is it its of on or our that the this to we will with you your they their who what can all about into using use work team".split(" "),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#./ -]/g, " ")
    .split(/[\s/]+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Case-insensitive whole-term match that handles symbols like C#, C++, Node.js. */
export function containsTerm(haystack: string, term: string): boolean {
  const esc = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9+#])`, "i").test(haystack.toLowerCase());
}

/** Numbers/metrics in a string, normalised: "1,000+" -> "1000", "~40%" -> "40%", "$30K" -> "30k". */
export function extractNumbers(text: string): string[] {
  const out: string[] = [];
  const re = /\$?\d[\d,]*(?:\.\d+)?\s*(?:%|k\b|m\b|x\b)?/gi;
  for (const m of text.match(re) ?? []) {
    const n = m.replace(/[\s,$]/g, "").toLowerCase();
    if (/^(19|20)\d\d$/.test(n)) continue; // years are fine to restate
    out.push(n);
  }
  return out;
}

export function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export async function pLimit<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}
