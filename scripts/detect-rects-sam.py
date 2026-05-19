#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "sam-2 @ git+https://github.com/facebookresearch/sam2.git",
#   "torch",
#   "torchvision",
#   "opencv-python-headless",
#   "numpy",
#   "pillow",
#   "huggingface-hub",
# ]
# ///
"""SAM2 auto-mask candidate detection via facebookresearch/sam2.

Generates masks across the scan with dense point grid, filters by bbox.
Outputs annot.jpg + regions.json under data/.cv-cache/<pkg>-<page>-sam/.

Usage: uv run scripts/detect-rects-sam.py <package> <page-id>
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path

import cv2
import numpy as np
import torch
from PIL import Image
from huggingface_hub import hf_hub_download
from sam2.build_sam import build_sam2
from sam2.automatic_mask_generator import SAM2AutomaticMaskGenerator

REPO = Path(__file__).resolve().parent.parent

MIN_W = int(os.environ.get("MIN_W", 25))
MAX_W = int(os.environ.get("MAX_W", 180))
MIN_H = int(os.environ.get("MIN_H", 40))
MAX_H = int(os.environ.get("MAX_H", 220))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("package")
    ap.add_argument("page_id")
    ap.add_argument("--model", default="facebook/sam2.1-hiera-base-plus")
    ap.add_argument("--points-per-side", type=int, default=48)
    args = ap.parse_args()

    scan = REPO / f"data/MJC-400/{args.package}/scans/{args.page_id}.jpg"
    out_dir = REPO / f"data/.cv-cache/{args.package}-{args.page_id}"
    out_dir.mkdir(parents=True, exist_ok=True)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"device: {device}")

    # Resolve checkpoint + config from HF hub
    repo_id = args.model
    ckpt = hf_hub_download(repo_id=repo_id, filename="sam2.1_hiera_base_plus.pt")
    cfg = "configs/sam2.1/sam2.1_hiera_b+.yaml"

    sam2 = build_sam2(cfg, ckpt, device=device)
    print(f"loaded {repo_id}")

    mask_gen = SAM2AutomaticMaskGenerator(
        sam2,
        points_per_side=args.points_per_side,
        pred_iou_thresh=0.55,
        stability_score_thresh=0.7,
        crop_n_layers=1,
        crop_overlap_ratio=0.4,
        min_mask_region_area=300,
        box_nms_thresh=0.5,
        points_per_batch=32,
    )

    img = np.array(Image.open(scan).convert("RGB"))
    print(f"image: {img.shape}")

    with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16, enabled=device == "cuda"):
        masks = mask_gen.generate(img)
    print(f"raw masks: {len(masks)}")

    rects: list[tuple[int, int, int, int]] = []
    for m in masks:
        x, y, w, h = m["bbox"]  # XYWH
        w = int(w)
        h = int(h)
        if not (MIN_W <= w <= MAX_W and MIN_H <= h <= MAX_H):
            continue
        if w / h > 4 or h / w > 5:
            continue
        rects.append((int(x), int(y), w, h))

    # NMS
    def iou(a, b):
        ax1, ay1, aw, ah = a
        bx1, by1, bw, bh = b
        ax2, ay2 = ax1 + aw, ay1 + ah
        bx2, by2 = bx1 + bw, by1 + bh
        ix1, iy1 = max(ax1, bx1), max(ay1, by1)
        ix2, iy2 = min(ax2, bx2), min(ay2, by2)
        if ix2 <= ix1 or iy2 <= iy1:
            return 0.0
        inter = (ix2 - ix1) * (iy2 - iy1)
        union = aw * ah + bw * bh - inter
        return inter / union

    rects.sort(key=lambda r: -r[2] * r[3])
    keep = []
    for r in rects:
        if all(iou(r, k) < 0.3 for k in keep):
            keep.append(r)
    rects = sorted(keep, key=lambda r: (r[1] // 80, r[0]))

    regions = [
        {"id": i + 1, "x": int(x), "y": int(y), "w": int(w), "h": int(h)}
        for i, (x, y, w, h) in enumerate(rects)
    ]

    gray = cv2.imread(str(scan), cv2.IMREAD_GRAYSCALE)
    annot = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    for rg in regions:
        cv2.rectangle(annot, (rg["x"], rg["y"]), (rg["x"] + rg["w"], rg["y"] + rg["h"]), (0, 0, 255), 3)
        label = str(rg["id"])
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 1.2, 3)
        cv2.rectangle(annot, (rg["x"], rg["y"] - th - 8), (rg["x"] + tw + 8, rg["y"]), (0, 0, 255), -1)
        cv2.putText(annot, label, (rg["x"] + 4, rg["y"] - 4), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 255), 3, cv2.LINE_AA)
    cv2.imwrite(str(out_dir / "annot.jpg"), annot, [cv2.IMWRITE_JPEG_QUALITY, 92])
    (out_dir / "regions.json").write_text(json.dumps(regions, indent=2))
    print(f"detected {len(regions)} regions → {out_dir}")


if __name__ == "__main__":
    main()
