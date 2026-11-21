#!/usr/bin/env python3
"""앱 폴더 하나를 HTML 파일 하나로 묶는다. 메신저로 보내거나 폰에 받아 두고 열 수 있게.

  python3 tools/한파일.py 앱/짤뽑기공유              # → 앱/짤뽑기공유/짤뽑기공유.html
  python3 tools/한파일.py 앱/짤뽑기공유 --out 다른곳.html

묶는 것:
  - <link rel="stylesheet"> → <style>
  - 아이콘 → data: 주소. manifest는 뺀다 (파일로 열면 설치가 안 된다)
  - <script type="module" src> 와 그 안의 상대 경로 import 전부 → importmap의 data: 모듈
    (import 경로는 "묶음:<경로>" 같은 맨 이름으로 바꿔서, data: 모듈 안에서도 풀린다)
  - 앱 폴더의 .json 파일 → 페이지 안에 넣고, fetch("이름.json")이 그것을 돌려주게 한다

안 되는 것:
  - 서비스워커(파일에는 못 붙는다. 앱 쪽에서 file: 이면 안 붙이게 해 둘 것)
  - 동적 import(import(...)), 폴더 밖 그림 파일, CSS 안의 url(...)
  - 파일로 열면 출처(origin)가 주소판과 달라서 저장한 데이터가 주소판과 따로 논다
"""
import argparse, base64, json, mimetypes, pathlib, re, sys

IMPORT_RE = re.compile(r"""(^\s*(?:import|export)\s[^;'"]*?\sfrom\s*|^\s*import\s*)(["'])(\.{1,2}/[^"']+)\2""", re.M)


def data_url(text, mime):
    return f"data:{mime};base64," + base64.b64encode(text.encode()).decode()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("앱", help="앱 폴더 (예: 앱/짤뽑기공유)")
    ap.add_argument("--out", help="쓸 파일 (기본: 앱폴더/<이름>.html)")
    a = ap.parse_args()

    app = pathlib.Path(a.앱).resolve()
    index = app / "index.html"
    if not index.is_file():
        sys.exit(f"index.html이 없음: {index}")
    out = pathlib.Path(a.out).resolve() if a.out else app / f"{app.name}.html"
    html = index.read_text()

    # 스타일
    def css(m):
        f = app / m.group(1)
        return f"<style>\n{f.read_text()}\n</style>"
    html = re.sub(r'<link rel="stylesheet" href="([^"]+)">', css, html)

    # 아이콘, manifest
    def icon(m):
        f = app / m.group(2)
        mime = mimetypes.guess_type(f.name)[0] or "image/svg+xml"
        return f'<link rel="{m.group(1)}" href="{data_url(f.read_text(), mime)}">'
    html = re.sub(r'<link rel="(icon|apple-touch-icon)" href="([^"]+)">', icon, html)
    html = re.sub(r'<link rel="manifest"[^>]*>\n?', "", html)

    # 모듈: 진입 파일부터 상대 import를 따라가며 모은다
    m = re.search(r'<script type="module" src="([^"]+)"></script>', html)
    if not m:
        sys.exit('<script type="module" src="…"> 를 못 찾음')
    entry = (app / m.group(1)).resolve()
    mods = {}  # 실제 경로 → 맨 이름

    def name_of(p):
        return "묶음:" + str(p.relative_to(app.parent)).replace("\\", "/")

    def walk(p):
        if p in mods:
            return
        if not p.is_file():
            sys.exit(f"import한 파일이 없음: {p}")
        mods[p] = None
        src = p.read_text()
        if re.search(r"\bimport\s*\(", src):
            print(f"주의: {p.name}에 동적 import가 있음. 묶이지 않는다", file=sys.stderr)

        def rep(mm):
            dep = (p.parent / mm.group(3)).resolve()
            walk(dep)
            return f"{mm.group(1)}{mm.group(2)}{name_of(dep)}{mm.group(2)}"
        mods[p] = IMPORT_RE.sub(rep, src)

    walk(entry)
    imap = {name_of(p): data_url(src, "text/javascript") for p, src in mods.items() if p != entry}

    # json 파일 → fetch가 돌려주게
    jsons = {f.name: f.read_text() for f in sorted(app.glob("*.json"))}
    shim = ""
    if jsons:
        payload = json.dumps(jsons, ensure_ascii=False).replace("</", "<\\/")
        shim = (
            f'<script type="application/json" id="묶은파일">{payload}</script>\n'
            "<script>\n"
            "// 한파일.py가 넣음: 앱 폴더의 .json을 fetch로 읽던 것을 페이지 안의 글로 돌려준다\n"
            "(() => {\n"
            "  const files = JSON.parse(document.getElementById('묶은파일').textContent);\n"
            "  const real = window.fetch.bind(window);\n"
            "  window.fetch = (input, init) => {\n"
            "    const u = typeof input === 'string' ? input : input && input.url;\n"
            "    const k = u && !/^[a-z]+:/i.test(u) ? u.replace(/^\\.\\//, '') : null;\n"
            "    if (k && Object.prototype.hasOwnProperty.call(files, k))\n"
            "      return Promise.resolve(new Response(files[k], { headers: { 'Content-Type': 'application/json' } }));\n"
            "    return real(input, init);\n"
            "  };\n"
            "})();\n"
            "</script>\n"
        )

    entry_src = mods[entry].replace("</script", "<\\/script")
    block = (
        shim
        + '<script type="importmap">' + json.dumps({"imports": imap}) + "</script>\n"
        + '<script type="module">\n' + entry_src + "\n</script>"
    )
    html = html.replace(m.group(0), block)
    out.write_text(html)
    kb = out.stat().st_size // 1024
    print(f"묶음: {out}  {kb}KB  (모듈 {len(mods)}개, json {len(jsons)}개)")


if __name__ == "__main__":
    main()
