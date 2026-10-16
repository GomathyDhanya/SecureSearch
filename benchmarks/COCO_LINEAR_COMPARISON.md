# Clustered encrypted ANN versus encrypted linear scan

This comparison uses the first 320 public COCO val2017 images, five captions from distinct images, the same 512-D q8 CLIP embeddings, actual CKKS scoring, AES-GCM storage, authenticated Fastify requests, and local persistence. It distinguishes two baselines:

1. **Same-store exhaustive:** scan all 320 vectors in the *same clustered ciphertext store* as the ANN run. This is the cleanest paired query-time comparison, with no difference in stored data or update history.
2. **Flat encrypted scan:** append each 64-image batch as an encrypted leaf and never cluster or merge; query all leaves. This is a no-index system baseline and exposes the index's update/storage cost. It was run separately on the same host, so cross-run timing is descriptive.

| Measurement | Buffered ANN, 4 sealed probes | Same-store exhaustive | Flat encrypted scan |
|---|---:|---:|---:|
| Mean scored images | 150.4 / 320 (47.0%) | 320 / 320 | 320 / 320 |
| Mean server CKKS compute | **1.70 s** | 3.83 s | 3.31 s |
| Median search through ranking | **2.04 s** | 3.93 s | 3.55 s |
| Exact-cosine ANN Recall@10 | **86%** | 100% | 100% |
| Total update time for 320 images | 4.72 s | same clustered build | **1.75 s** |
| Commit payload | 44.40 MB | same clustered build | **22.38 MB** |
| Old encrypted leaf downloads | 3.71 MB | same clustered build | **0** |
| Stored CKKS vector ciphertext | 19.88 MB | same clustered store | **17.67 MB** |

The paired same-store comparison gives a **2.25× mean server-compute speedup** and **1.93× median end-to-end score/rank speedup** for ANN at this low-recall setting. Relative to a flat no-index system, building the clustered index roughly doubles commit traffic and takes 2.7× as long to ingest this small corpus. The flat scan also packs 64-record batches efficiently, using less stored ciphertext than the small clustered leaves.

For a less aggressive routing point, a *plaintext routing-quality* sweep on 1,000 COCO captions at the same 320-image state found:

| Sealed probes | ANN Recall@10 | Images scored |
|---:|---:|---:|
| 4 | 89.5% | 49.4% |
| 6 | 96.1% | 67.0% |
| 8 | 99.2% | 81.0% |
| 10 | 99.9% | 94.1% |
| Exhaustive | 100% | 100% |

**Do not transfer the 4-probe encrypted speedup to the 6- or 8-probe quality points.** Their encrypted latencies were not measured, and CKKS cost need not scale perfectly with candidate count. At 320 images, high recall leaves relatively little pruning benefit. The earlier 5,000-image live segmented layout reached 95.11% ANN Recall@10 while scoring 19.92% of images at 32 probes, but that full-corpus result measures routing quality, not an encrypted latency speedup for the buffer.

The encrypted timings are only five queries in one run, without WAN, full JPEG upload, browser embedding, or steady-state concurrent load. The ANN and exhaustive queries ran sequentially, which can introduce warm-cache/order effects; the flat baseline ran in a separate process. Results therefore establish a functional measured tradeoff, not a statistically supported systems throughput claim. Raw reports: [paired same-store CKKS](COCO_BUFFERED_VS_LINEAR_320.json), [flat encrypted scan](COCO_LINEAR_320.json), and [1,000-caption routing sweep](COCO_BUFFERED_320_PROBE_SWEEP.json).

For a conference comparison, repeat at 100k+ public images on independent collections, report a query/update mix and tail latencies, match Recall@10, and include both flat CKKS scan and optimized plaintext ANN systems. A high-recall encrypted ANN win must cover the ongoing index maintenance and full snapshot transfer, not only the server's arithmetic time.
