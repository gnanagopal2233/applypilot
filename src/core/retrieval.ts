import crypto from "node:crypto";
import { getDb } from "./db";
import type { Embedder } from "./llm";
import { tokenize } from "./text";

export interface Doc {
  id: string;
  text: string;
}
export interface Hit {
  id: string;
  score: number;
}

/** Okapi BM25 over a small in-memory corpus (experience bank, answer bank). */
export class BM25 {
  private docs: { id: string; tf: Map<string, number>; len: number }[];
  private df = new Map<string, number>();
  private avgLen: number;
  constructor(corpus: Doc[], private k1 = 1.5, private b = 0.75) {
    this.docs = corpus.map((d) => {
      const toks = tokenize(d.text);
      const tf = new Map<string, number>();
      toks.forEach((t) => tf.set(t, (tf.get(t) ?? 0) + 1));
      tf.forEach((_, t) => this.df.set(t, (this.df.get(t) ?? 0) + 1));
      return { id: d.id, tf, len: toks.length };
    });
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / Math.max(1, this.docs.length);
  }
  search(query: string, k = 10): Hit[] {
    const q = [...new Set(tokenize(query))];
    const N = this.docs.length;
    return this.docs
      .map((d) => {
        let s = 0;
        for (const t of q) {
          const f = d.tf.get(t);
          if (!f) continue;
          const df = this.df.get(t) ?? 0;
          const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
          s += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / this.avgLen));
        }
        return { id: d.id, score: s };
      })
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

function cosine(a: number[], b: number[]) {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function embedCached(embedder: Embedder, texts: string[]): Promise<number[][]> {
  const db = getDb();
  const keys = texts.map((t) => crypto.createHash("sha1").update(t).digest("hex"));
  const get = db.prepare("SELECT vector FROM embeddings WHERE key = ?");
  const out: (number[] | null)[] = keys.map((k) => {
    const row = get.get(k) as { vector: string } | undefined;
    return row ? JSON.parse(row.vector) : null;
  });
  const missing = out.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  if (missing.length) {
    const vecs = await embedder.embed(missing.map((i) => texts[i]));
    const put = db.prepare("INSERT OR REPLACE INTO embeddings (key, vector) VALUES (?, ?)");
    missing.forEach((i, j) => {
      out[i] = vecs[j];
      put.run(keys[i], JSON.stringify(vecs[j]));
    });
  }
  return out as number[][];
}

/**
 * Hybrid retrieval: BM25 (always) + dense embeddings (when configured), fused with
 * Reciprocal Rank Fusion so neither score scale dominates.
 */
export async function hybridSearch(corpus: Doc[], query: string, k: number, embedder: Embedder | null): Promise<Hit[]> {
  const lexical = new BM25(corpus).search(query, corpus.length);
  if (!embedder) return lexical.slice(0, k);
  const [qv, ...dv] = await embedCached(embedder, [query.slice(0, 8000), ...corpus.map((d) => d.text)]);
  const dense = corpus.map((d, i) => ({ id: d.id, score: cosine(qv, dv[i]) })).sort((a, b) => b.score - a.score);
  const rrf = new Map<string, number>();
  const K = 60;
  lexical.forEach((h, r) => rrf.set(h.id, (rrf.get(h.id) ?? 0) + 1 / (K + r)));
  dense.forEach((h, r) => rrf.set(h.id, (rrf.get(h.id) ?? 0) + 1 / (K + r)));
  return [...rrf.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
