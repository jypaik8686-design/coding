#!/usr/bin/env python3
"""이 세션에서 실제로 되는 것과 안 되는 것을 돌려 보고 알려 준다.

저장소에 든 것은 어느 세션에나 따라온다. 따라오지 않는 것은 기계에 깔린 것(node, playwright)과
환경에 든 것(제미니 열쇠)이다. 짐작하지 않고 하나씩 실제로 돌려 본다.
세션을 시작하면 이것부터 돌린다. ✗가 붙은 것은 그 세션에서 된다고 말하지 않는다.

  python3 tools/ready.py
"""
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
sys.dont_write_bytecode = True


def 돌려(cmd: list[str], timeout: int = 60) -> tuple[int, str]:
    try:
        r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout + r.stderr).strip()
    except FileNotFoundError:
        return 127, f"{cmd[0]} 없음"
    except subprocess.TimeoutExpired:
        return 124, f"{timeout}초 안에 안 끝남"


def 첫줄(s: str) -> str:
    return s.splitlines()[0] if s else ""


def 파이썬() -> tuple[bool, str, str]:
    v = sys.version_info
    ok = v >= (3, 10)
    return ok, f"{v.major}.{v.minor}.{v.micro}", "" if ok else "3.10 이상이 필요하다 (도구가 3.10 문법을 쓴다)"


def 노드() -> tuple[bool, str, str]:
    code, out = 돌려(["node", "--version"], 15)
    return code == 0, 첫줄(out), "" if code == 0 else "node를 깐다. 없으면 스크린샷 도구만 못 쓴다"


def 스크린샷() -> tuple[bool, str, str]:
    code, out = 돌려(["node", "tools/shot.mjs", "--점검"], 60)
    if code == 0:
        return True, 첫줄(out), ""
    return False, 첫줄(out), "npm i -D playwright && npx playwright install chromium  (클라우드 세션에는 이미 깔려 있다)"


def 제미니() -> tuple[bool, str, str]:
    try:
        import gemini
        return gemini.점검()
    except Exception as e:  # 도구 자체가 깨졌을 때도 나머지 점검은 계속한다
        return False, f"tools/gemini.py 를 못 읽음: {e}", ""


def 자기점검() -> tuple[bool, str, str]:
    code, out = 돌려([sys.executable, "tools/check_toolbox.py"], 120)
    if code == 0:
        return True, 첫줄(out), ""
    줄 = [l for l in out.splitlines() if l.strip()]
    return False, f"{len(줄) - 1}개 어긋남: {줄[0] if 줄 else ''}", "python3 tools/check_toolbox.py 로 전부 보고 고친다"


def 앱주소() -> tuple[bool, str, str]:
    """앱을 폰에서 여는 주소(GitHub Pages)가 살아 있는지, 지금 있는 앱이 다 올라가 있는지 본다."""
    켜는법 = ("사용자만 켤 수 있다. 저장소 Settings → Pages → Source 'Deploy from a branch' → 기본 가지, / (root) → Save\n"
              "  무료 요금제는 공개 저장소에서만 된다. 순서는 내놓기 스킬 맨 아래에 있다")
    _, 원격 = 돌려(["git", "remote", "get-url", "origin"], 15)
    m = re.search(r"github\.com[:/]+([^/\s]+)/([^/\s]+?)(?:\.git)?/?$", 원격.strip())
    if not m:
        return False, "원격 주소에서 저장소 이름을 못 읽음", ""
    바탕 = f"https://{m.group(1).lower()}.github.io/{m.group(2)}/"
    try:
        import gemini
        맥락 = gemini.ssl맥락()
    except Exception:
        맥락 = None
    try:
        with urllib.request.urlopen(바탕, timeout=20, context=맥락) as r:
            글 = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return False, f"꺼져 있음 (HTTP {e.code})  {바탕}", 켜는법
    except urllib.error.URLError as e:
        return False, f"못 닿음: {e.reason}  {바탕}", ""
    올라간 = {urllib.parse.unquote(x) for x in re.findall(r'href="앱/([^/"]+)/"', urllib.parse.unquote(글))}
    여기 = {d.name for d in (ROOT / "앱").iterdir() if d.is_dir() and (d / "index.html").is_file()}
    빠진 = sorted(여기 - 올라간)
    if 빠진:
        return True, f"{바탕}  — 주소에 아직 없는 앱: {', '.join(빠진)} (기본 가지에 병합되고 1~2분 뒤에 나온다)", ""
    return True, f"{바탕}  — 앱 {len(여기)}개 전부 올라가 있음", ""


def 가지() -> str:
    _, 지금 = 돌려(["git", "rev-parse", "--abbrev-ref", "HEAD"], 15)
    _, 원격 = 돌려(["git", "ls-remote", "--symref", "origin", "HEAD"], 30)
    기본 = ""
    for l in 원격.splitlines():
        if l.startswith("ref: refs/heads/"):
            기본 = l.split("refs/heads/")[1].split()[0]
    _, 안올린 = 돌려(["git", "status", "--porcelain"], 15)
    n = len([l for l in 안올린.splitlines() if l.strip()])
    말 = f"{지금 or '?'}  (기본 가지: {기본 or '확인 못 함'})  안 올린 파일 {n}개"
    if 기본 and 지금 and 지금 != 기본:
        말 += f"\n{'':14}→ 이 가지에서 고친 것은 {기본} 에 병합돼야 다음 세션이 받는다"
    return 말


def main() -> int:
    if "--help" in sys.argv or "-h" in sys.argv:
        print(__doc__)
        return 0
    점검들 = [("파이썬", 파이썬), ("node", 노드), ("스크린샷", 스크린샷), ("제미니", 제미니), ("자기점검", 자기점검), ("앱 주소", 앱주소)]
    결과 = {}
    print(f"이 세션에서 되는 것  ({datetime.now():%Y-%m-%d %H:%M})\n")
    for 이름, f in 점검들:
        ok, 상태, 고침 = f()
        결과[이름] = ok
        print(f"  {'✓' if ok else '✗'} {이름:<8}  {상태}")
        if not ok and 고침:
            for l in 고침.splitlines():
                print(f"{'':14}→ {l}" if not l.startswith(" ") else f"{'':14}  {l.strip()}")
    print(f"  · {'가지':<8}  {가지()}")

    스킬 = [
        ("앱뼈대", ["파이썬", "자기점검"]),
        ("기능요구서", ["파이썬"]),
        ("눈으로확인", ["파이썬", "node", "스크린샷"]),
        ("제미니브리지", ["파이썬", "제미니"]),
        ("내놓기", ["파이썬", "자기점검", "앱 주소"]),
    ]
    print("\n스킬")
    for 이름, 필요 in 스킬:
        빠진 = [n for n in 필요 if not 결과[n]]
        print(f"  {'✓' if not 빠진 else '✗'} {이름}" + (f"  — {', '.join(빠진)} 때문에 이 세션에서는 다 못 한다" if 빠진 else ""))
    return 0 if 결과["파이썬"] and 결과["자기점검"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
