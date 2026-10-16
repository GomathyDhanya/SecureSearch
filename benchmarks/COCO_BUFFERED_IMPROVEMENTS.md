# Simple buffered-index improvements (16 October 2026)

This follow-up keeps the existing index structure. It changes one protocol detail: `/index?since=<version>` returns a small `unchanged` response when the client's snapshot is current. The client reuses its decrypted routing index; a new device or a changed version still receives the full encrypted snapshot. No new class, service, or background compactor was added.

The seal-size sweep tested the actual buffered update algorithm on public COCO val2017 image embeddings. For every layout, ANN truth is exhaustive cosine top ten on the same pinned q8 CLIP embeddings; official image relevance uses the COCO caption `image_id`. The full result includes **5,000 images and all 25,014 captions**, with uncertainty calculated across 5,000 image-level means. Layout measurements use plaintext vectors and are not CKKS latency results.

| Full COCO, 5,000 images | Probe count | ANN Recall@10 | Images scored | Vector placements over growth | Old vectors fetched |
|---|---:|---:|---:|---:|---:|
| Existing live segmented index, 500-image seals | 32 | 95.11% | 19.92% | 29,004 | 24,004 |
| Opaque buffer, 500-image seals | **36** | **95.03%** | **21.86%** | **15,980** | **10,980** |

The buffered index reduces vector placements by **44.9%** and old-vector fetches by **54.3%** at nearly the same observed ANN recall, for **1.94 percentage points more** vectors scored per query. This is a comparison of two fixed operating points, not a statistical equivalence test. Their image-level normal 95% recall intervals overlap: 94.86–95.19% for the buffer and 94.94–95.28% for the live index. Official image Recall@1 is 21.92% and 21.95%, respectively; this low absolute number reflects the underlying embedding/relevance task, not just the ANN index.

The new buffer-size sweep shows why the 500-image default remains a reasonable write-optimized choice, while allowing callers to configure smaller seals for query-heavy periods:

| Buffer seal count at 5,000 images | Pending at endpoint | Placements | Largest plaintext layout update | Recall@10 / candidates at 32 probes |
|---:|---:|---:|---:|---:|
| 64 | 8 | 18,376 | 2.60 s | 94.30% / 20.47% |
| 256 | 136 | 17,096 | 3.06 s | 94.69% / 24.68% |
| 500 | 0 | **15,980** | 3.92 s | 94.13% / **19.69%** |

The layout-update timings are single-run JavaScript measurements, so only the placement and fetch counts are robust cross-run comparisons. A large buffer has a larger query penalty immediately before a seal: at 2,992 images with 492 pending, 500-image seals needed 41.3% candidates for 96.4% recall at 24 probes. At the same checkpoint, 256-image seals needed 37.4% candidates for 96.0% recall at 24 probes, but used 8,432 versus 7,232 placements. The previous [checkpoint report](COCO_BUFFERED_RESEARCH_REPORT.md) explains this phase effect. The UI now starts direct search at 36 probes; the seal size remains 500 for the opt-in buffer.

**Snapshot traffic.** In a real AES-GCM/CKKS/Fastify pilot with 320 COCO images and five query requests, all `/index` responses totaled **622 bytes** after the version check. One full response for the same final index is **397,379 bytes**. A separate one-query run recorded 394 total index-response bytes; these are actual serialized API payload sizes. The optimization removes repeated client downloads and decryption of an unchanged index. It does not reduce the server's underlying head read, the full response after a cross-device update, or the single MongoDB document-size limit.

The real-encryption pilot and API tests verify that the buffered index still commits, searches pending rows, seals, and syncs to another device. The second device receives a full snapshot when the version changes. Eleven server tests, client lint, and production build pass. No large-scale encrypted latency measurement, independent 100k-image dataset, whole-transcript privacy proof, or claim of conference readiness follows from this work.

Raw reports: [buffered full COCO](COCO_BUFFERED_FULL_25K.json), [live segmented full COCO](COCO_LIVE_LAYOUT_FULL.json), [64-image seal sweep](COCO_BUFFERED_B64_5000.json), [256-image seal sweep](COCO_BUFFERED_B256_5000.json), [snapshot traffic](COCO_SNAPSHOT_CACHE_320.json), and [single-query snapshot size](COCO_SNAPSHOT_CACHE_BYTES_320.json).
