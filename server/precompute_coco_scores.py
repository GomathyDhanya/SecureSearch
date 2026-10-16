"""Exact float64 cosine matrix for the prepared COCO embeddings.

This replaces a slow JavaScript 25k x 5k x 512 dot-product loop. It does not
change labels or use a different model. The binary matrix is row-major in the
same caption/image order as the JSONL files; metadata prevents stale reuse.
"""
import json
import os
import hashlib
from pathlib import Path

import numpy as np

root = Path(os.environ.get("COCO_OUT", "../benchmarks/coco-val2017")).resolve()
manifest = json.loads((root / "manifest.json").read_text())


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def vectors(name):
    rows = [json.loads(line) for line in (root / name).read_text().splitlines() if line]
    return rows, np.asarray([row["vector"] for row in rows], dtype=np.float64)


images, image_vectors = vectors("images.jsonl")
captions, caption_vectors = vectors("captions.jsonl")
if len(images) != manifest["imageCount"] or len(captions) != manifest["captionCount"]:
    raise ValueError("COCO embedding JSONL files are incomplete")
if image_vectors.shape[1] != 512 or caption_vectors.shape[1] != 512:
    raise ValueError("Expected 512-dimensional CLIP vectors")

matrix_path = root / "scores.f64"
scores = np.memmap(matrix_path, mode="w+", dtype="<f8", shape=(len(captions), len(images)))
block = int(os.environ.get("SCORE_BLOCK", "256"))
for start in range(0, len(captions), block):
    stop = min(start + block, len(captions))
    scores[start:stop] = caption_vectors[start:stop] @ image_vectors.T
    print(f"Scored captions {stop}/{len(captions)}", flush=True)
scores.flush()
metadata = {
    "dtype": "float64-le",
    "shape": [len(captions), len(images)],
    "annotationSha256": manifest["annotationSha256"],
    "imageIdsSha256": manifest["imageIdsSha256"],
    "captionIdsSha256": manifest["captionIdsSha256"],
    "imageEmbeddingsSha256": sha256(root / "images.jsonl"),
    "captionEmbeddingsSha256": sha256(root / "captions.jsonl"),
    "numpyVersion": np.__version__,
    "scoreDefinition": "normalized caption vector dot normalized image vector",
}
(root / "scores-metadata.json").write_text(json.dumps(metadata, indent=2))
print(f"Saved {matrix_path} ({matrix_path.stat().st_size} bytes)")
