# Retrieval eval fixtures (#524)

`vectors.json` holds the MiniLM embeddings for every string in `corpus.ts` and
`queries.ts`, committed so `retrieval-eval.test.ts` runs offline in ~19 ms.
Without it the per-file throwaway `BERNARD_HOME` gives the embedder an empty
model cache and it re-downloads 23 MB on every `npm test`, in CI too.

**Regenerate whenever a corpus or query string changes.** The map is keyed by
text, so an edited string fails loudly ("no committed vector for …") rather than
silently shifting the vectors by one.

```
npx tsx -e "$(cat <<'JS'
const fs = require('node:fs');
(async () => {
  const { RETRIEVAL_CORPUS } = await import('./src/__tests__/fixtures/retrieval/corpus.js');
  const { RETRIEVAL_QUERIES } = await import('./src/__tests__/fixtures/retrieval/queries.js');
  const { getEmbeddingProvider, EMBEDDING_MODEL_ID } = await import('./src/embeddings.js');
  const p = await getEmbeddingProvider();
  const keys = [...RETRIEVAL_CORPUS.map(r => r.fact), ...RETRIEVAL_QUERIES.map(q => q.query)];
  const vecs = await p.embed(keys);
  const dims = p.dimensions();
  const flat = new Float32Array(keys.length * dims);
  vecs.forEach((v, i) => flat.set(Float32Array.from(v), i * dims));
  fs.writeFileSync('src/__tests__/fixtures/retrieval/vectors.json', JSON.stringify({
    model: EMBEDDING_MODEL_ID, dimensions: dims, count: keys.length, keys,
    base64: Buffer.from(flat.buffer).toString('base64'),
  }));
})();
JS
)"
```

The baseline in `retrieval-eval.test.ts` is measured against these vectors, so
regenerating with a different embedding model will move it — which is the
change #520's other half is about, and should be its own PR.
