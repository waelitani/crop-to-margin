#!/usr/bin/env python3
"""Reference implementation of the Crop to Margin measurement, for checking the
plugin's arithmetic against a real PDF outside Zotero.

Mirrors addon/content/crop-to-margin.js: same page sampling, the same modal
background / minimum-ink detector, the same low-percentile consensus, the same
mirrored-margin handling and width equalisation. Run it on a file to see what
the plugin will do to it, and how much bigger the text ends up.

    python3 tools/analyze_margins.py book.pdf --per-page

Requires PyMuPDF (pip install pymupdf) and NumPy. The plugin itself has no
dependencies; this is a development aid only.
"""

import argparse
import sys

try:
    import fitz  # PyMuPDF
    import numpy as np
except ImportError as exc:  # pragma: no cover
    sys.exit(f"needs pymupdf and numpy: {exc}")


def pick_pages(num_pages, count):
    """Evenly spaced page indexes, skipping covers and end matter.

    Successive picks alternate recto/verso: an evenly spaced walk with an even
    stride would otherwise stay on one side of the book and mirrored margins
    would go undetected.
    """
    first, last = 0, num_pages - 1
    if num_pages > 20:
        first = int(num_pages * 0.03)
        last = int(np.ceil(num_pages * 0.97)) - 1
    span = last - first
    n = min(count, span + 1)
    out = []
    for i in range(n):
        index = first if n == 1 else first + round(i * span / (n - 1))
        if (index + 1) % 2 != i % 2:
            index += 1 if index < last else -1
        index = min(last, max(first, index))
        if index not in out:
            out.append(index)
    return out


def ink_box(gray, threshold, min_ink):
    """Bounding box of everything that is not page background.

    The background level is the modal luminance rather than a fixed white, and a
    row or column must carry `min_ink` pixels before it counts.
    """
    histogram = np.bincount(gray.ravel(), minlength=256)
    background = int(histogram.argmax())
    mask = np.abs(gray.astype(np.int16) - background) > threshold

    rows = np.flatnonzero(mask.sum(axis=1) >= min_ink)
    cols = np.flatnonzero(mask.sum(axis=0) >= min_ink)
    if rows.size == 0 or cols.size == 0:
        return None
    return int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1


def measure_page(page, render_width, threshold, min_ink):
    rect = page.rect
    if rect.width <= 0 or rect.height <= 0:
        return None
    scale = render_width / rect.width
    pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale),
                             colorspace=fitz.csGRAY, alpha=False)
    gray = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(pixmap.height, pixmap.width)
    box = ink_box(gray, threshold, min_ink)
    if box is None:
        return None
    x0, y0, x1, y1 = box
    w, h = pixmap.width, pixmap.height
    return {
        "page_width": rect.width,
        "page_height": rect.height,
        "l": x0 / w,
        "r": 1 - x1 / w,
        "t": y0 / h,
        "b": 1 - y1 / h,
        "area": ((x1 - x0) * (y1 - y0)) / (w * h),
    }


def percentile(values, p):
    values = sorted(values)
    if not values:
        return 0.0
    position = p * (len(values) - 1)
    low = int(position)
    high = min(low + 1, len(values) - 1)
    return values[low] + (values[high] - values[low]) * (position - low)


def shrink_to_fit(a, b, min_content):
    total, cap = a + b, 1 - min_content
    if total <= cap or total <= 0:
        return a, b
    k = cap / total
    return a * k, b * k


def clusters(samples, bin_size=0.01):
    """Sampled pages grouped by the text block they share, biggest group first.

    A textbook is mostly body: one layout repeated for hundreds of pages, with
    front matter, chapter openers, plates and an index as minorities. Binning the
    left/right insets separates that body layout from the rest.
    """
    groups = {}
    for s in samples:
        key = (round(s["l"] / bin_size), round(s["r"] / bin_size))
        groups.setdefault(key, []).append(s)
    return sorted(groups.values(), key=len, reverse=True)


def body_insets(samples, quantile):
    """Insets of the body layout: the smallest margin the body itself ever uses.

    Within one layout the minimum is the safe crop — it is set by the page whose
    ink reaches furthest. Any *other* layout a quarter of the sample also uses is
    folded in, because a crop that clips a third of the document is not a
    consensus; rarer layouts are left to the per-page guard. When nothing
    dominates we fall back to a low percentile.
    """
    groups = clusters(samples)
    dominant = max(3, -(-len(samples) * 4 // 10))
    if groups and len(groups[0]) >= dominant:
        common = max(2, -(-len(samples) // 4))
        members = [s for i, g in enumerate(groups) if i == 0 or len(g) >= common for s in g]
        out = {k: min(s[k] for s in members) for k in "lrtb"}
        out.update(pages=len(members), clustered=True)
        return out
    out = {k: percentile([s[k] for s in samples], quantile) for k in "lrtb"}
    out.update(pages=len(samples), clustered=False)
    return out


def consensus(samples, quantile, max_crop, padding_pts, mirror, min_content=0.4):
    usable = [s for s in samples if s["area"] >= 0.005]
    if len(usable) < 2:
        return None

    page_width = percentile([s["page_width"] for s in usable], 0.5)
    page_height = percentile([s["page_height"] for s in usable], 0.5)
    pad_x = padding_pts / page_width if page_width else 0.0
    pad_y = padding_pts / page_height if page_height else 0.0

    def trim(value, pad):
        return min(max_crop, max(0.0, value - pad))

    odd = [s for s in usable if (s["index"] + 1) % 2 == 1]
    even = [s for s in usable if (s["index"] + 1) % 2 == 0]

    mirrored = False
    if mirror and len(odd) >= 3 and len(even) >= 3:
        odd_body, even_body = body_insets(odd, quantile), body_insets(even, quantile)
        if abs(odd_body["l"] - even_body["l"]) > 0.02 or abs(odd_body["r"] - even_body["r"]) > 0.02:
            mirrored = True
    if not mirrored:
        odd_body = even_body = body_insets(usable, quantile)

    horizontal = {
        "odd": {"l": trim(odd_body["l"], pad_x), "r": trim(odd_body["r"], pad_x)},
        "even": {"l": trim(even_body["l"], pad_x), "r": trim(even_body["r"], pad_x)},
    }
    # One vertical crop for both sides, so facing pages stay the same height.
    top = trim(min(odd_body["t"], even_body["t"]), pad_y)
    bottom = trim(min(odd_body["b"], even_body["b"]), pad_y)

    # Same content width on every page, so scrolling does not resize the text.
    total = min(horizontal["odd"]["l"] + horizontal["odd"]["r"],
                horizontal["even"]["l"] + horizontal["even"]["r"])
    for side in horizontal.values():
        s = side["l"] + side["r"]
        if s > total and s > 0:
            k = total / s
            side["l"] *= k
            side["r"] *= k

    top, bottom = shrink_to_fit(top, bottom, min_content)
    for side in horizontal.values():
        side["l"], side["r"] = shrink_to_fit(side["l"], side["r"], min_content)

    return {
        "mirrored": mirrored,
        "samples": len(usable),
        "body_pages": odd_body["pages"] + (even_body["pages"] if mirrored else 0),
        "clustered": odd_body["clustered"],
        "page_width": page_width,
        "page_height": page_height,
        "odd": dict(horizontal["odd"], t=top, b=bottom),
        "even": dict(horizontal["even"], t=top, b=bottom),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pdf")
    parser.add_argument("--samples", type=int, default=16)
    parser.add_argument("--render-width", type=int, default=240)
    parser.add_argument("--threshold", type=int, default=12)
    parser.add_argument("--min-ink", type=int, default=2)
    parser.add_argument("--quantile", type=float, default=0.15)
    parser.add_argument("--max-crop", type=float, default=0.30)
    parser.add_argument("--padding", type=float, default=6.0)
    parser.add_argument("--no-mirror", action="store_true")
    parser.add_argument("--json", metavar="PATH",
                        help="write the raw samples and the chosen crop to a JSON file")
    parser.add_argument("--per-page", action="store_true",
                        help="print the measurement of every sampled page")
    parser.add_argument("--verify", nargs="?", type=int, const=1, default=None,
                        metavar="STRIDE",
                        help="re-measure every STRIDE-th page and report how many "
                             "keep all their content under the chosen crop")
    args = parser.parse_args()

    doc = fitz.open(args.pdf)
    indexes = pick_pages(doc.page_count, args.samples)

    samples = []
    for index in indexes:
        sample = measure_page(doc[index], args.render_width, args.threshold, args.min_ink)
        if sample is None:
            if args.per_page:
                print(f"  page {index + 1:>5}  blank")
            continue
        sample["index"] = index
        samples.append(sample)
        if args.per_page:
            print(f"  page {index + 1:>5}  l={sample['l']:.4f} r={sample['r']:.4f} "
                  f"t={sample['t']:.4f} b={sample['b']:.4f} area={sample['area']:.3f}")

    crop = consensus(samples, args.quantile, args.max_crop, args.padding, not args.no_mirror)
    if crop is None:
        print("no measurable content")
        return 1

    if args.json:
        import json
        with open(args.json, "w") as fh:
            rename = {"page_width": "pageWidth", "page_height": "pageHeight"}
            json.dump({
                "pages": doc.page_count,
                "samples": [{rename.get(k, k): v for k, v in s.items()} for s in samples],
                "crop": crop,
            }, fh, indent=2)
            fh.write("\n")

    print(f"\n{args.pdf}")
    print(f"  {doc.page_count} pages, {crop['page_width']:.1f} x {crop['page_height']:.1f} pt, "
          f"{crop['samples']} measured")
    print(f"  mirrored margins: {'yes' if crop['mirrored'] else 'no'}")
    print(f"  body layout: {'locked onto ' + str(crop['body_pages']) + ' of the sampled pages'
                            if crop['clustered'] else 'no dominant layout, using percentiles'}")
    for name in ("odd", "even"):
        c = crop[name]
        print(f"  {name:>5}: left {c['l'] * 100:5.2f}%  right {c['r'] * 100:5.2f}%  "
              f"top {c['t'] * 100:5.2f}%  bottom {c['b'] * 100:5.2f}%")

    width_fraction = 1 - crop["odd"]["l"] - crop["odd"]["r"]
    height_fraction = 1 - crop["odd"]["t"] - crop["odd"]["b"]
    print(f"  content: {width_fraction * 100:.1f}% of page width, "
          f"{height_fraction * 100:.1f}% of page height")
    print(f"  fitting the crop to the pane instead of the page magnifies the text "
          f"{1 / width_fraction:.2f}x "
          f"({(1 / width_fraction ** 2 - 1) * 100:.0f}% more ink on screen)")

    if args.verify:
        verify(doc, crop, args)
    return 0


def verify(doc, crop, args):
    """Check the crop chosen from a handful of samples against the whole file."""
    first = int(doc.page_count * 0.03) if doc.page_count > 20 else 0
    last = int(np.ceil(doc.page_count * 0.97)) - 1 if doc.page_count > 20 else doc.page_count - 1
    checked = clipped = blank = 0
    body_checked = body_clipped = 0
    worst = []
    for index in range(0, doc.page_count, args.verify):
        sample = measure_page(doc[index], args.render_width, args.threshold, args.min_ink)
        if sample is None or sample["area"] < 0.005:
            blank += 1
            continue
        checked += 1
        in_body = first <= index <= last
        body_checked += in_body
        side = crop["odd"] if (index + 1) % 2 == 1 else crop["even"]
        # How far the page's ink reaches past the crop, as a fraction of the page.
        over = max(side["l"] - sample["l"], side["r"] - sample["r"],
                   side["t"] - sample["t"], side["b"] - sample["b"])
        if over > 0.002:  # ~1 pt on a letter page; below that it is the render grid
            clipped += 1
            body_clipped += in_body
            worst.append((over, index + 1))
    kept = checked - clipped
    body_kept = body_checked - body_clipped
    print(f"\n  verified {checked} pages ({blank} blank/unmeasurable, "
          f"stride {args.verify})")
    print(f"  body (pages {first + 1}-{last + 1}): {body_kept} of {body_checked} keep all "
          f"their ink ({body_kept / max(body_checked, 1) * 100:.1f}%)")
    print(f"  whole file: {kept} of {checked} ({kept / max(checked, 1) * 100:.1f}%) — the "
          f"plugin relaxes the crop on any page whose text reaches past it")
    if worst:
        worst.sort(reverse=True)
        shown = ", ".join(f"p{page} by {over * 100:.1f}% of the page"
                          for over, page in worst[:5])
        print(f"  worst overhangs: {shown}")


if __name__ == "__main__":
    sys.exit(main())
