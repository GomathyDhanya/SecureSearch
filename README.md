# SecureLens — encrypted semantic image search

Personal photo search where the server never sees plaintext. The client embeds images with CLIP, builds and maintains the search index, and encrypts everything with CKKS homomorphic encryption before it leaves the device. The server only ever holds evaluation keys: it computes similarity over ciphertexts and returns encrypted scores, which the client decrypts and ranks. Started from wanting encrypted search that doesn't trust the server with plaintext.

## How it works

1. **Client embeds.** Images are embedded on-device with a quantized CLIP model (downloaded once, runs in the browser). Text queries are embedded the same way.
2. **Client builds the index.** An incremental centroid hierarchy (spherical clustering) is built and maintained client-side. The client seals versioned encrypted segments on a fixed schedule (500-image seals) and merges them through single server commits.
3. **Everything is encrypted.** Embeddings, queries, the routing index, and scores are CKKS-encrypted client-side. The server receives evaluation keys only — never secret keys, never plaintext.
4. **Server computes blindly.** Ciphertext–ciphertext similarity runs server-side over the routed groups; encrypted scores come back for the client to decrypt and rank.
5. **Two search modes.** Adaptive search expands groups until private score bounds rule out the rest. Query-private cover mode instead sends one randomized fixed-size group set per query, giving a per-query ε-local-DP guarantee on the access pattern.



## Threat model

Honest-but-curious server. In ordinary mode the server sees account identity, which groups are touched, timing, sizes, and fetched image IDs — but never plaintext, queries, or keys. Cover mode hides the per-query access pattern (ε composes across queries) but not account, timing, or updates. Update locations are visible; there is no cross-epoch unlinkability claim. A guaranteed-best-plus-decoys variant improves recall but carries no finite ε guarantee — repeated queries can intersect covers to identify the guaranteed group. This is not a full oblivious database.

## Measured results

On COCO val2017 (5,000 images, 25,014 captions, pinned q8 CLIP embeddings), with ANN truth as exhaustive cosine top-10:

| Index | Probes | Recall@10 | Vectors scored |
|---|---|---:|---:|
| Opaque buffer, 500-image seals | 36 | 95.03% | 21.86% |

In a real-encryption pilot (320 images, actual CKKS over the wire), adaptive search gave a 2.25× mean server-compute speedup over a same-store exhaustive scan (1.70s vs 3.83s) at 86% recall. Version-aware index sync cut repeated snapshot downloads from 397,379 bytes to 622 bytes total across five queries. Details and scoping are in [benchmarks/COCO_BUFFERED_IMPROVEMENTS.md](benchmarks/COCO_BUFFERED_IMPROVEMENTS.md) and [benchmarks/COCO_LINEAR_COMPARISON.md](benchmarks/COCO_LINEAR_COMPARISON.md) — read the caveats there; the short version is these are measured tradeoffs on fixed setups, not production latency claims.

## Run it

Requires Node 24.12+ (for `--experimental-wasm-exnref`), npm, and a recent browser.

```sh
# terminal 1 — server (local demo store)
cd server && npm ci && npm run demo

# terminal 2 — client
cd client && npm ci && npm run dev
```

Open http://127.0.0.1:5173, click **Run synthetic demo**, then **Search demo vectors**. This runs real encryption end to end on 256 synthetic 512-D vectors — not a mock. The comparison checkbox runs exhaustive encrypted search to measure recall and cost for the same query. Real-image mode embeds with CLIP locally on first use (heavier); keep synthetic and real-image vaults separate, since the fixtures live in a different vector space.

The demo server binds loopback only and stores data in `server/.local-data-v2/` (git-ignored, single process). JWTs last 8 hours; without `JWT_SECRET`, a restart invalidates sessions but encrypted data persists. Save the recovery file — losing the vault key loses access. Don't expose this research server publicly as-is.

## Reproduce the measurements

```sh
cd server
npm test              # unit + API tests
npm run bench         # synthetic CKKS ANN benchmark (N=1024 default)
npm run bench:report  # readable report from the benchmark output
```

Tune with `N=2048 Q=16 SEEDS=42,43,44 PROBES=1,2,4,8,16 npm run bench`. The microbenchmark excludes HTTP, storage, index sync, model inference, image fetch, and cold key loading — it is not an end-to-end latency estimate.

COCO protocol: `npm run bench:coco:prepare` embeds all 5,000 val2017 images and 25,014 captions with the q8 CLIP model, then `npm run bench:coco` evaluates exact cosine, fixed probes, and private cover at several ε values. Dataset and model cache are local and git-ignored — fetch them from their official sources to reproduce.

```sh
cd client
npm run lint
npm run build
```

## Layout

| Path | What it does |
|---|---|
| `shared/ckks.mjs` | node-seal 7 CKKS setup, interleaved packing, server-side reduction |
| `shared/index.mjs` | Incremental spherical clustering, private summaries, leaf angular bounds |
| `shared/segments.mjs` | Count-scheduled encrypted segment sealing and merging |
| `shared/adaptive.mjs` | Progressive search with private stopping bounds |
| `shared/private-probe.mjs` | Fixed-size ε-local-DP cover mode |
| `shared/vault-client.mjs` | Client key handling, encrypted snapshots, upload/search |
| `shared/crypto.mjs` | WebCrypto AES-GCM envelopes |
| `server/app.mjs` | v2 API; server holds evaluation keys, never secret keys |
| `server/storage.mjs` | Local store + MongoDB/R2 adapter |
| `server/benchmark_*.mjs` | Synthetic, COCO, and live-segment benchmarks |
| `client/src/crypto-worker.js` | Browser worker for client-side HE ops |

`npm start` runs v2 against MongoDB/R2 (set `MONGO_URI`, `JWT_SECRET`, and the R2 credentials); the default is the local adapter. The old `server/server.js` and custom WASM build are v1 reference code, not the launch path — old vaults have no migration, and the old password-wrapped key design should not be relied on.

## Status

Research prototype. What's solid: the crypto protocol, the index design, and the measurements above. What's not: production hardening (rate limiting, multi-user eval workers, backups, garbage collection), large-scale latency evaluation, and any claim beyond what's measured.
