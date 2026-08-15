#!/usr/bin/env python3
"""Build dist/app.html — the whole app inlined into one shareable file.

Usage: python3 build.py
Inlines styles.css, demo-data.js, engine.js, and app.js into index.html,
and strips the outer html/head/body skeleton (the artifact host adds its own).
"""
import re, pathlib

root = pathlib.Path(__file__).parent
html = (root / "index.html").read_text()

# keep only what's inside <body> plus the <title>/<style> for the host wrapper
html = re.sub(r"^.*?<title>", "<title>", html, flags=re.S)
html = html.replace('<link rel="stylesheet" href="styles.css">', "")
html = re.sub(r"</head>\s*<body>\s*", "\n", html, flags=re.S)
html = re.sub(r"\s*</body>\s*</html>\s*$", "\n", html, flags=re.S)

html = html.replace("</title>", "</title>\n<style>\n" + (root / "styles.css").read_text() + "</style>")
for src in ["demo-data.js", "engine.js", "app.js"]:
    js = (root / src).read_text().replace("</script>", "<\\/script>")
    html = html.replace(f'<script src="{src}"></script>', "<script>\n" + js + "</script>")

out = root / "dist" / "app.html"
out.parent.mkdir(exist_ok=True)
out.write_text(html)
print(f"wrote {out} ({len(html) // 1024} KB)")
