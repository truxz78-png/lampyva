#!/usr/bin/env python3
"""Lampyva — one page per tool, made from index.html.

People search for a task ("remove background", "HEIC to JPG"), not for "Lampyva".
Each page here is the full Lampyva (all tools work) with its own title, description,
headline and main button, so search engines can show the right page for each search.

Run it after every change to index.html:  python3 tools/make-pages.py
(the daily robot checks that the pages are up to date with index.html).
"""
import html
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = "https://truxz78-png.github.io/lampyva/"

TOOLS = [  # (anchor, button text) in the order of the hero buttons
    ("convert", "Convert formats"),
    ("upscale", "Enlarge images now"),
    ("remove-bg", "Remove background"),
    ("pod", "Print-on-demand"),
]

PAGES = [
    {
        "file": "upscale-image.html",
        "focus": "upscale",
        "title": "Free AI Image Upscaler — Enlarge Photos 2× and 4× | Lampyva",
        "desc": "Upscale images with AI for free: make small photos, drawings and logos 2× or 4× bigger and sharper right in your browser. No sign-up, no watermark, nothing uploaded.",
        "h1": "Enlarge images with AI",
        "h1b": "for free",
        "p": "Make small photos, drawings and logos 2× or 4× bigger and sharper, right in your browser. No sign-up and no watermark — your images never leave your device.",
    },
    {
        "file": "remove-background.html",
        "focus": "remove-bg",
        "title": "Remove Image Background Free — Transparent PNG | Lampyva",
        "desc": "Remove the background from photos for free and get a transparent PNG, a solid color or WebP. Works in your browser: no sign-up, no watermark, nothing uploaded.",
        "h1": "Remove the background",
        "h1b": "in seconds",
        "p": "Cut out people, products, pets and drawings and get a transparent PNG or a solid color. Free, no sign-up — your photos never leave your device.",
    },
    {
        "file": "image-converter.html",
        "focus": "convert",
        "title": "Free Image Converter — HEIC to JPG, PNG, WebP, PDF | Lampyva",
        "desc": "Convert images for free: HEIC, PNG, JPG, WebP, AVIF, TIFF, SVG and more to JPG, PNG, WebP, PDF, ICO or GIF. Many at once, right in your browser, nothing uploaded.",
        "h1": "Convert images",
        "h1b": "to any format",
        "p": "Turn HEIC, PNG, JPG, WebP, AVIF, TIFF, SVG and more into JPG, PNG, WebP, PDF, ICO or GIF — many at once, free and private, right in your browser.",
    },
    {
        "file": "print-on-demand.html",
        "focus": "pod",
        "title": "Print-on-Demand Image Prep — 5000×6000 PNG, 300 DPI | Lampyva",
        "desc": "Prepare designs for Redbubble, Amazon Merch, Spreadshirt, TeePublic and more: remove the white background, enlarge and center as a transparent 300 DPI PNG. Free.",
        "h1": "Print-ready designs",
        "h1b": "in one tap",
        "p": "Remove the white background, enlarge and center your design as a transparent 300 DPI PNG at the exact size each print-on-demand store asks for.",
    },
]


def sub1(pattern, repl, text):
    new, n = re.subn(pattern, lambda m: repl, text, count=1, flags=re.S)
    if n != 1:
        raise SystemExit(f"make-pages: could not find {pattern!r} in index.html")
    return new


def build(src, page):
    e = html.escape
    out = src
    out = sub1(r"<title>.*?</title>", f"<title>{e(page['title'])}</title>", out)
    out = sub1(r'<link rel="canonical" href="[^"]*">', f'<link rel="canonical" href="{BASE}{page["file"]}">', out)
    out = sub1(r'<meta name="description" content="[^"]*">', f'<meta name="description" content="{e(page["desc"])}">', out)
    out = sub1(r'<meta property="og:title" content="[^"]*">', f'<meta property="og:title" content="{e(page["title"])}">', out)
    out = sub1(r'<meta property="og:description" content="[^"]*">', f'<meta property="og:description" content="{e(page["desc"])}">', out)
    out = sub1(r"<body>", f'<body data-page="{page["focus"]}">', out)
    out = sub1(r"<h1>Give your images <span>new light</span></h1>", f"<h1>{e(page['h1'])} <span>{e(page['h1b'])}</span></h1>", out)
    hero_p = re.search(r"(<h1>.*?</h1>\s*<p>)(.*?)(</p>)", out, re.S)
    out = out[: hero_p.start(2)] + e(page["p"]) + out[hero_p.end(2):]
    # main buttons: this page's tool first (gold), the others after
    order = [t for t in TOOLS if t[0] == page["focus"]] + [t for t in TOOLS if t[0] != page["focus"]]
    buttons = "\n".join(
        f'        <a class="btn {"btn-donate" if i == 0 else "btn-ghost"}" href="#{a}">{e(label)}</a>'
        for i, (a, label) in enumerate(order)
    )
    m = re.search(r'(<div class="actions">\n)(.*?)(\n\s*</div>)', out, re.S)
    out = out[: m.start(2)] + buttons + out[m.end(2):]
    return out


def main():
    src = (ROOT / "index.html").read_text(encoding="utf-8")
    for page in PAGES:
        (ROOT / page["file"]).write_text(build(src, page), encoding="utf-8")
        print("made", page["file"])


if __name__ == "__main__":
    main()
