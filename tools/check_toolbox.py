#!/usr/bin/env python3
"""도구함 자기점검. 도구목록.md와 실제 파일이 어긋나면 잡는다.

문제 없으면 요약 한 줄과 exit 0, 있으면 한 줄씩 찍고 exit 1.
도구나 스킬을 더하고 나서 이걸 돌리면, 목록에 적는 걸 잊었는지 바로 나온다.

  python3 tools/check_toolbox.py
"""
import re
import subprocess
import sys
import unicodedata
from pathlib import Path
from urllib.parse import unquote

필수폴더 = ["tools", ".claude/skills", "틀", "앱", "화면"]
링크 = re.compile(r"\]\((<[^>]+>|[^)]+)\)")
코드 = re.compile(r"`[^`]*`|^```.*?^```", re.S | re.M)
앞머리 = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.S)
표의스킬 = re.compile(r"^\|\s*`([^`]+)`\s*\|", re.M)
건너뛰기 = {"__pycache__", ".DS_Store"}


def 정규(s: str) -> str:
    return unicodedata.normalize("NFC", s.strip().removeprefix("./"))


def 링크모으기(글: str) -> set[str]:
    모음 = set()
    for raw in 링크.findall(코드.sub("", 글)):
        t = raw[1:-1] if raw.startswith("<") else raw
        t = 정규(unquote(t.split("#")[0]))
        if t and "://" not in t:
            모음.add(t)
    return 모음


def 검사(root: Path) -> list[str]:
    문제 = [f"필수 폴더 없음: {d}" for d in 필수폴더 if not (root / d).is_dir()]

    목록 = root / "도구목록.md"
    if not 목록.is_file():
        return 문제 + ["도구목록.md 없음 — 도구함이 자기가 뭘 가졌는지 모른다"]
    글 = 목록.read_text(encoding="utf-8")
    적힌것 = 링크모으기(글)

    for t in sorted(적힌것):
        if not (root / t).exists():
            문제.append(f"도구목록 링크 깨짐: {t}")

    # tools/ 안의 실행물은 전부 목록에 있어야 한다
    도구폴더 = root / "tools"
    if 도구폴더.is_dir():
        for f in sorted(도구폴더.iterdir()):
            if not f.is_file() or f.name in 건너뛰기 or f.suffix == ".pyc":
                continue
            rel = 정규(f.relative_to(root).as_posix())
            if rel not in 적힌것:
                문제.append(f"도구목록에 없는 도구: {rel}")

    # 스킬: 폴더마다 SKILL.md, 앞머리에 name·description, 목록에도 있어야 한다
    스킬폴더 = root / ".claude/skills"
    있는스킬 = set()
    if 스킬폴더.is_dir():
        for d in sorted(p for p in 스킬폴더.iterdir() if p.is_dir()):
            있는스킬.add(정규(d.name))
            md = d / "SKILL.md"
            rel = 정규(md.relative_to(root).as_posix())
            if not md.is_file():
                문제.append(f"SKILL.md 없는 스킬 폴더: {d.name}")
                continue
            if rel not in 적힌것:
                문제.append(f"도구목록에 없는 스킬: {rel}")
            m = 앞머리.match(md.read_text(encoding="utf-8"))
            if not m:
                문제.append(f"스킬 앞머리(--- name/description ---) 없음: {rel}")
                continue
            머리 = m.group(1)
            이름 = re.search(r"^name:\s*(.+)$", 머리, re.M)
            설명 = re.search(r"^description:\s*(.+)$", 머리, re.M)
            if not 이름:
                문제.append(f"스킬에 name 없음: {rel}")
            elif 정규(이름.group(1)) != 정규(d.name):
                문제.append(f"스킬 name이 폴더 이름과 다름: {rel} (name={이름.group(1).strip()}, 폴더={d.name})")
            if not 설명:
                문제.append(f"스킬에 description 없음 — 이게 없으면 스스로 못 찾는다: {rel}")
            elif len(설명.group(1).strip()) < 20:
                문제.append(f"스킬 description이 너무 짧아 언제 쓸지 알 수 없음: {rel}")

    # CLAUDE.md 표에 적어 둔 스킬이 실제로 있는지
    규칙 = root / "CLAUDE.md"
    if not 규칙.is_file():
        문제.append("CLAUDE.md 없음 — 세션이 규칙을 못 읽는다")
    else:
        규칙글 = 규칙.read_text(encoding="utf-8")
        for 이름 in 표의스킬.findall(규칙글):
            if 정규(이름) not in 있는스킬:
                문제.append(f"CLAUDE.md가 가리키는 스킬이 없음: {이름}")
        for 칸 in ("## 대답", "## 교정기록"):
            if not re.search(rf"^{re.escape(칸)}\s*$", 규칙글, re.M):
                문제.append(f"CLAUDE.md에 '{칸}' 칸이 없음 — 다음 세션이 말하는 법과 교정받은 것을 잊는다")

    # 틀은 바로 열려야 한다
    틀들 = sorted(p for p in (root / "틀").iterdir() if p.is_dir()) if (root / "틀").is_dir() else []
    for d in 틀들:
        for 파일 in ("index.html", "명세.md"):
            if not (d / 파일).is_file():
                문제.append(f"틀에 {파일} 없음: 틀/{d.name}")

    # 깐 앱은 명세를 들고 있어야 한다
    앱들 = sorted(p for p in (root / "앱").iterdir() if p.is_dir()) if (root / "앱").is_dir() else []
    for d in 앱들:
        if not (d / "명세.md").is_file():
            문제.append(f"앱에 명세.md 없음: 앱/{d.name}")
        if any("{{앱이름}}" in f.read_text(encoding="utf-8", errors="ignore")
               for f in d.rglob("*") if f.is_file() and f.suffix in {".html", ".js", ".css", ".md", ".webmanifest", ".svg"}):
            문제.append(f"틀 자리표시자 {{{{앱이름}}}}가 그대로 남아 있음: 앱/{d.name}")

    # 서랍(맨 위 index.html)은 앱 주소의 첫 화면이다. 앱 목록과 어긋나면 사용자가 새 앱을 못 찾는다
    try:
        sys.path.insert(0, str(root / "tools"))
        import drawer
        서랍 = root / "index.html"
        if not 서랍.is_file() or 서랍.read_text(encoding="utf-8") != drawer.만들기():
            문제.append("서랍(index.html)이 낡았음 — python3 tools/drawer.py")
        if not (root / ".nojekyll").is_file():
            문제.append(".nojekyll 없음 — python3 tools/drawer.py")
        for d in 앱들:
            if not drawer.한줄(d):
                문제.append(f"명세의 '한 줄'이 비어 있음 (서랍에 그대로 나온다): 앱/{d.name}")
    except Exception as e:
        문제.append(f"서랍을 확인하지 못함: {e}")

    # 이 저장소 하나만으로 돌아야 한다. 다른 저장소나 이 기계만의 경로에 기대면 잡는다
    # idea-bin은 아이디어를 넘기는 행선지 이름이라 CLAUDE.md와 세션기록.md에만 쓸 수 있다. 없어도 돌아야 하므로 도구·스킬·앱은 기대면 안 된다
    밖 = re.compile(r"/home/[A-Za-z0-9_.-]+/|/Users/[A-Za-z0-9_.-]+/|idea-bin")
    밖_경로만 = re.compile(r"/home/[A-Za-z0-9_.-]+/|/Users/[A-Za-z0-9_.-]+/")
    글꼴 = {".md", ".py", ".mjs", ".js", ".html", ".css", ".json", ".webmanifest"}
    for f in sorted(root.rglob("*")):
        rel = f.relative_to(root)
        if not f.is_file() or f.suffix not in 글꼴 or rel.parts[0] in {".git", "화면", "node_modules"}:
            continue
        if rel.as_posix() == "tools/check_toolbox.py":
            continue
        검사 = 밖_경로만 if rel.as_posix() in {"CLAUDE.md", "세션기록.md"} else 밖
        m = 검사.search(f.read_text(encoding="utf-8", errors="ignore"))
        if m:
            문제.append(f"저장소 밖에 기댐 ('{m.group(0)}'): {정규(rel.as_posix())}")

    # 실행물이 실제로 돌아가는 모양인지
    for f in sorted((root / "tools").glob("*.py")):
        r = subprocess.run([sys.executable, "-m", "py_compile", str(f)], capture_output=True)
        if r.returncode:
            문제.append(f"파이썬 문법 오류: {정규(f.relative_to(root).as_posix())}")
    node있음 = subprocess.run(["which", "node"], capture_output=True).returncode == 0
    if node있음:
        for f in sorted((root / "tools").glob("*.mjs")):
            r = subprocess.run(["node", "--check", str(f)], capture_output=True)
            if r.returncode:
                문제.append(f"자바스크립트 문법 오류: {정규(f.relative_to(root).as_posix())}")

    return 문제


def main() -> int:
    if "--help" in sys.argv or "-h" in sys.argv:
        print(__doc__)
        return 0
    root = Path(__file__).resolve().parent.parent
    문제 = 검사(root)
    if 문제:
        for p in 문제:
            print(p)
        print(f"\n{len(문제)}개 어긋남.", file=sys.stderr)
        return 1
    도구 = len([f for f in (root / "tools").iterdir() if f.is_file() and f.suffix != ".pyc"])
    스킬 = len([d for d in (root / ".claude/skills").iterdir() if d.is_dir()])
    틀 = len([d for d in (root / "틀").iterdir() if d.is_dir()])
    앱 = len([d for d in (root / "앱").iterdir() if d.is_dir()])
    print(f"이상 없음 — 도구 {도구}, 스킬 {스킬}, 틀 {틀}, 앱 {앱}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
