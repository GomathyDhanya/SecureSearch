# SecureLens: encrypted personal search prototype

A working experimental system for a personal collection, including use across devices. Images, embeddings, queries, numeric scores, and the client routing index are encrypted at the storage/search server. The client builds an incremental centroid hierarchy; the server performs CKKS ciphertext–ciphertext similarity computation and dimension reduction. The client decrypts and ranks scalar scores.

**This is encrypted-content search, not a zero-knowledge or fully oblivious database.** In ordinary mode the server sees account identity, group membership/occupancy, selected groups, update locations, adaptive round counts/stopping behavior, sizes, timing, and fetched image IDs. Query-private cover mode randomizes a fixed-size group set and returns all images in it, giving a conditional one-query ε-local-DP access-pattern guarantee without hiding account, timing, or updates. See [the formal scope](docs/private-cover.md) and [the design and threat model](docs/design.md).

## Run locally

Use Node 24.12+ with support for `--experimental-wasm-exnref` (tested on 24.12.0), npm, and a recent browser supporting the node-seal 7 WASM build.

In one terminal:

```sh
cd server
npm ci
npm run demo
```

In another:

```sh
cd client
npm ci
npm run dev
```

Open **http://127.0.0.1:5173/**. Click **Run synthetic demo**, then **Search demo vectors**. This generates 256 synthetic 512-dimensional vectors and illustrative cards; it uses actual encryption, persistent encrypted local storage, HTTP, and server computation. These fixtures do **not** establish real-image retrieval accuracy. The comparison checkbox runs exhaustive encrypted search to measure recall and cost for the same query.

- Adaptive search expands groups until its private bounds exclude unseen groups, or all groups have been searched. Its stopping statement assumes CKKS score error ≤ 0.0001; this is an experimentally checked tolerance, not a formal cryptographic bound. Near-tied scores can still change order.
- The UI defaults to direct search over 36 globally ranked leaf centroids to favor measured recall when access leakage is acceptable. On all COCO val2017 captions, the opt-in opaque-buffer index recovered 95.03% of exhaustive top-10 cosine neighbors while scoring 21.86% of vectors at 36 probes. The client scans decrypted leaf summaries; the server sees selected groups and the fetched result ID. Change the probe count or enable a cover where supported in the search controls.
- New vaults use a 500-image pending segment. At each fixed-count boundary the client seals it and merges equal-size encrypted index runs through one versioned server commit. Older monolithic snapshots remain readable. The server performs query scoring; the client still performs clustering and compaction, which can be expensive for large runs. This schedule does not hide update locations or establish cross-epoch unlinkability.
- An unchanged index version now returns a small version response, so repeated searches on one device reuse its decrypted routing snapshot. A changed version still downloads the encrypted snapshot for cross-device consistency.
- Query-private cover mode sends one randomized fixed-size group set and receives all encrypted images in those groups. Its local quality audit makes no additional requests. This can sharply lower recall and raise bandwidth; ε values compose across repeated searches. It is an alternative to adaptive mode, not a full oblivious database.
- Guaranteed-best-plus-decoys cover always includes the best routed group(s) and fills the cover with random groups. It improves recall, but **has no finite ε-DP guarantee** for the server-visible group set; repeated queries can identify the guaranteed group by intersecting covers. See the [decoy privacy analysis](docs/private-cover.md#guaranteed-best-groups-plus-random-decoys).
- Disable adaptive search for fixed-width ANN; increasing groups generally improves coverage and costs more work.
- Create a separate empty vault for real images; synthetic fixtures and CLIP embeddings are different vector spaces and cannot be mixed.
- Real-image upload downloads quantized CLIP locally on first use. Images and text are embedded on the client. This is substantially heavier than synthetic mode; embedding is not outsourced.
- Save the recovery file. Account password and vault key have different purposes. The independent random vault key never goes to the server; it decrypts the key bundle and data. Losing it loses access. A demo recovery file includes the generated demo login password as well.
- Another device unlocks using account email/password and the same vault key. Snapshot conflicts reject concurrent writes instead of silently overwriting another device's index. Retry with a fresh upload after conflict; interrupted uploads can leave orphaned objects.

The development server binds loopback only. Local data lives in ignored `server/.local-data-v2/`. It is a single-process store. JWTs expire after eight hours; without a configured `JWT_SECRET`, restarting invalidates sessions, but encrypted data persists. Do not expose this research server publicly as-is.

## Test and reproduce measurements

```sh
cd server
npm test
npm run bench
npm run bench:report
```

Default benchmark: N=1024, 512 dimensions, eight independent queries per distribution, clustered and isotropic synthetic vectors, top-10 recall. It uses actual CKKS operations and compares the legacy-style client reduction, server reduction, fixed probes, adaptive bounds, and a four-group adaptive budget.

```sh
N=2048 Q=16 SEEDS=42,43,44 PROBES=1,2,4,8,16 npm run bench
npm run bench:report
```

Results go to `benchmarks/ann-results.json`; set `OUT` to retain separate runs. [Measured results](benchmarks/REPORT.md) document scope and limitations. The microbenchmark excludes HTTP, storage, index synchronization, model inference, image fetch, and cold key loading. It is not an end-to-end production latency estimate. Run without concurrent heavy workloads.

For real-image relevance and ANN recall, use the [official COCO val2017 benchmark protocol](docs/private-cover.md#real-image-evaluation-protocol). `server/prepare_coco.mjs` embeds all 5,000 validation images and 25,014 captions with the browser's q8 CLIP model; `server/benchmark_coco.mjs` evaluates exact cosine, fixed probes, and private cover at several ε values on those embeddings. The [measured COCO report](benchmarks/COCO_REPORT.md) gives the reproducible results and limitations. The dataset and model cache are local ignored files, so download them from their cited official sources to reproduce the run.

The [research novelty audit](docs/research-novelty-audit.md) compares this implementation with encrypted ANN and private-search prior work, distinguishes its measured results from novelty claims, and states the experiments needed for a publishable contribution.
The [systems paper target](docs/systems-paper-target.md) defines the candidate contribution and the comparisons that would falsify it; the [live segment protocol](docs/segmented-index.md) records its current privacy and client-cost limits.
The [dynamic systems experiment](benchmarks/COCO_DYNAMIC_SYSTEMS_REPORT.md) measures client-held global centroid routing and a scheduled-merge layout on the same COCO corpus. Its 5,000-image write counts are modeled; the live segmented upload path was added afterward. Run `npm run bench:coco:live` from `server/` for a small real-encryption upload/search pilot; it measures HTTP payload bytes and actual CKKS time but excludes media bytes and model inference.
The [live-segment report](benchmarks/COCO_LIVE_SEGMENTS_REPORT.md) evaluates the implemented update algorithm on all 25,014 COCO captions and separates that full-corpus quality result from a 512-image real-encryption API pilot.
The [opaque-buffer COCO experiment](benchmarks/COCO_BUFFERED_RESEARCH_REPORT.md) tests an opt-in update-location privacy window at a 2,750-image growth checkpoint, including matched-recall layout results and a real CKKS pilot. Its [security scope](docs/opaque-buffer-research.md) is deliberately narrow; the prototype does not yet establish a conference-ready contribution.
The [full-corpus buffered follow-up](benchmarks/COCO_BUFFERED_IMPROVEMENTS.md) compares 5,000 images and all 25,014 captions at matched recall, sweeps seal sizes, and measures the simpler unchanged-index response optimization.

```sh
cd client
npm run lint
npm run build
```

## Architecture and files

| File | Purpose |
|---|---|
| `shared/index.mjs` | Incremental spherical clustering, private summaries, leaf angular bounds |
| `shared/segments.mjs` | Count-scheduled, client-built encrypted segment sealing and merging |
| `shared/adaptive.mjs` | Progressive search and conditional quality audit |
| `shared/private-probe.mjs` | Fixed-size ε-local-DP cover and one-request local audit |
| `shared/ckks.mjs` | node-seal 7 CKKS, interleaved packing, server reduction and response compaction |
| `shared/vault-client.mjs` | Trusted-client key handling, encrypted snapshots, uploads/search |
| `shared/crypto.mjs` | WebCrypto AES-GCM envelopes with purpose binding |
| `server/app.mjs` | Authenticated v2 API; server receives evaluation keys, never secret keys |
| `server/storage.mjs` | Local storage and MongoDB/R2 adapter |
| `server/benchmark_ann.mjs` | Reproducible synthetic CKKS benchmark |
| `server/prepare_coco.mjs`, `server/benchmark_coco.mjs` | Public COCO val2017 embedding and relevance/ANN evaluation |
| `server/benchmark_live_segments.mjs` | Real encrypted upload/search pilot on a COCO image prefix |
| `client/src/crypto-worker.js` | Browser worker for client HE operations |

## Cloud adapter

`npm start` runs v2 against MongoDB/R2 unless `STORAGE_MODE=local`. Set `MONGO_URI`, `JWT_SECRET`, `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY`, and `R2_SECRET_ACCESS_KEY` (or legacy `R2_SECRET_KEY`). This adapter uses new v2 collections/object prefixes. Cloud integration has not been exercised in this change; the demo uses the tested local adapter. Production also needs trusted client distribution, HTTPS, resource limits/rate limiting, backup/recovery, multi-user evaluation workers, and object garbage collection.

The old `server/server.js`, custom generated WASM, and legacy benchmark remain reference code. They are **not** the v2 launch path, and old encrypted vaults have no migration in this prototype. In particular, do not rely on the old password-wrapped key design for server confidentiality.
