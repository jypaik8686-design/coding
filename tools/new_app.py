#!/usr/bin/env python3
"""틀을 복사해 새 앱을 깐다. {{앱이름}}은 실제 이름으로 바뀐다.

  python3 tools/new_app.py 할일
  python3 tools/new_app.py 가계부 --틀 폰웹앱
"""
import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEXT = {".html", ".css", ".js", ".mjs", ".json", ".webmanifest", ".md", ".svg", ".txt"}


def main() -> int:
    ap = argparse.ArgumentParser(description="틀에서 새 앱 깔기")
    ap.add_argument("이름", help="앱 이름. 앱/<이름>/ 으로 들어간다")
    ap.add_argument("--틀", default="폰웹앱", help="쓸 틀 (기본: 폰웹앱)")
    a = ap.parse_args()

    src = ROOT / "틀" / a.틀
    dst = ROOT / "앱" / a.이름

    if not src.is_dir():
        있는것 = ", ".join(sorted(p.name for p in (ROOT / "틀").iterdir() if p.is_dir())) or "없음"
        print(f"그런 틀 없음: {a.틀}  (있는 틀: {있는것})", file=sys.stderr)
        return 1
    if dst.exists():
        print(f"이미 있음: {dst.relative_to(ROOT)}  (지우거나 다른 이름으로)", file=sys.stderr)
        return 1

    shutil.copytree(src, dst)
    바뀐파일 = 0
    for f in sorted(dst.rglob("*")):
        if f.is_file() and f.suffix.lower() in TEXT:
            t = f.read_text(encoding="utf-8")
            if "{{앱이름}}" in t:
                f.write_text(t.replace("{{앱이름}}", a.이름), encoding="utf-8")
                바뀐파일 += 1

    print(f"깔았음: 앱/{a.이름}/  (파일 {sum(1 for _ in dst.rglob('*') if _.is_file())}개, 이름 넣은 파일 {바뀐파일}개)")
    print()
    print("다음:")
    print(f"  1. 앱/{a.이름}/명세.md 를 채운다 (화면 목록, 데이터 모양)")
    print(f"  2. python3 tools/serve.py 앱/{a.이름} --조용히 &")
    print(f"  3. node tools/shot.mjs http://127.0.0.1:8000/ --out 화면/{a.이름}-처음.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
