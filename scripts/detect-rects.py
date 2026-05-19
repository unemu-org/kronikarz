#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["opencv-python-headless", "numpy", "pillow"]
# ///
"""Pre-process a scan and detect candidate gate-box rectangles.

Strategy: binarize, find contours, accept any quasi-rectangle in a plausible
size range. Over-detection is expected — vision-digitize-v2 sends the
annotated overlay to Claude with a prompt that filters out non-gates.

Outputs (under data/.cv-cache/<package>-<page-id>/):
  bin.png       — adaptive-threshold binary
  annot.jpg     — original scan with numbered red rectangles
  regions.json  — [{id, x, y, w, h}, ...]

Usage: uv run scripts/detect-rects.py <package> <page-id>
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path

import cv2
import numpy as np

REPO = Path(__file__).resolve().parent.parent

MIN_W = int(os.environ.get("MIN_W", 25))
MAX_W = int(os.environ.get("MAX_W", 140))
MIN_H = int(os.environ.get("MIN_H", 40))
MAX_H = int(os.environ.get("MAX_H", 200))


def detect(img_gray: np.ndarray) -> list[tuple[int, int, int, int]]:
    bin_inv = cv2.adaptiveThreshold(
        img_gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 25, 10
    )
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    closed = cv2.morphologyEx(bin_inv, cv2.MORPH_CLOSE, kernel, iterations=1)

    contours, _ = cv2.findContours(closed, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    candidates: list[tuple[int, int, int, int]] = []
    for c in contours:
        peri = cv2.arcLength(c, True)
        if peri < 120:
            continue
        approx = cv2.approxPolyDP(c, 0.05 * peri, True)
        if not (4 <= len(approx) <= 8):
            continue
        x, y, w, h = cv2.boundingRect(approx)
        if not (MIN_W <= w <= MAX_W and MIN_H <= h <= MAX_H):
            continue
        if w / h > 4 or h / w > 5:
            continue
        bbox_perim = 2 * (w + h)
        if peri < 0.8 * bbox_perim or peri > 1.8 * bbox_perim:
            continue
        candidates.append((x, y, w, h))
    return candidates


def nms(rects: list[tuple[int, int, int, int]], iou_thr: float = 0.3) -> list[tuple[int, int, int, int]]:
    if not rects:
        return []
    boxes = np.array([(x, y, x + w, y + h) for x, y, w, h in rects], dtype=np.float32)
    areas = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
    order = areas.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(int(i))
        xx1 = np.maximum(boxes[i, 0], boxes[order[1:], 0])
        yy1 = np.maximum(boxes[i, 1], boxes[order[1:], 1])
        xx2 = np.minimum(boxes[i, 2], boxes[order[1:], 2])
        yy2 = np.minimum(boxes[i, 3], boxes[order[1:], 3])
        inter = np.maximum(0, xx2 - xx1) * np.maximum(0, yy2 - yy1)
        iou = inter / (areas[i] + areas[order[1:]] - inter)
        order = order[1:][iou < iou_thr]
    return [rects[i] for i in keep]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("package")
    ap.add_argument("page_id")
    args = ap.parse_args()

    scan = REPO / f"data/MJC-400/{args.package}/scans/{args.page_id}.jpg"
    out_dir = REPO / f"data/.cv-cache/{args.package}-{args.page_id}"
    out_dir.mkdir(parents=True, exist_ok=True)

    gray = cv2.imread(str(scan), cv2.IMREAD_GRAYSCALE)
    if gray is None:
        raise SystemExit(f"cannot read {scan}")

    bin_img = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 25, 10
    )
    cv2.imwrite(str(out_dir / "bin.png"), bin_img)

    rects = detect(gray)
    rects = nms(rects, iou_thr=0.3)
    rects.sort(key=lambda r: (r[1] // 80, r[0]))

    regions = [
        {"id": i + 1, "x": int(x), "y": int(y), "w": int(w), "h": int(h)}
        for i, (x, y, w, h) in enumerate(rects)
    ]

    annot = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    for r in regions:
        cv2.rectangle(annot, (r["x"], r["y"]), (r["x"] + r["w"], r["y"] + r["h"]), (0, 0, 255), 3)
        label = str(r["id"])
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 1.2, 3)
        cv2.rectangle(annot, (r["x"], r["y"] - th - 8), (r["x"] + tw + 8, r["y"]), (0, 0, 255), -1)
        cv2.putText(annot, label, (r["x"] + 4, r["y"] - 4), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 255), 3, cv2.LINE_AA)
    cv2.imwrite(str(out_dir / "annot.jpg"), annot, [cv2.IMWRITE_JPEG_QUALITY, 92])
    (out_dir / "regions.json").write_text(json.dumps(regions, indent=2))
    print(f"detected {len(regions)} regions → {out_dir}")


if __name__ == "__main__":
    main()
