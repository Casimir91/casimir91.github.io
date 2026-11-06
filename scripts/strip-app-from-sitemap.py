#!/usr/bin/env python3
import re
from pathlib import Path

sitemap = Path(__file__).resolve().parent.parent / "_site" / "sitemap.xml"
if not sitemap.exists():
    raise SystemExit(0)

text = sitemap.read_text(encoding="utf-8")
text = re.sub(r"\s*<url>\s*<loc>[^<]*/app/[^<]*</loc>.*?</url>\n?", "\n", text, flags=re.S)
sitemap.write_text(text, encoding="utf-8")
