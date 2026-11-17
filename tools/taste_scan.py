#!/usr/bin/env python3
"""취향 훑기. 메모 폴더들을 훑어 여러 파일에 되풀이되는 낱말과, 좋고 싫음이 드러난 줄을 모은다.

공통점을 '판단'하지는 않는다. 판단은 세션이 이 결과를 읽고 한다 (`취향찾기` 스킬).
표준 라이브러리만 쓴다. 아무 데도 보내지 않고 화면에만 찍는다.

  python3 tools/taste_scan.py <폴더나 파일>... [--안쪽 <폴더나 파일>...]
                              [--부터 YYYY-MM-DD] [--이미 <취향 파일>...]
                              [--낱말 30] [--줄 60]

  --안쪽   일기·감정배설처럼 사적인 곳. 결과에 [안쪽] 표시가 붙는다.
           여기서 나온 것은 사적인 칸에만 적는다 (스킬 참고).
  --부터   이 날짜 이전 것은 뺀다. 파일 이름의 날짜와 줄 안의 (입고 YYYY-MM-DD …) 표시를 본다.
  --이미   이미 적어 둔 취향 파일. 거기 나오는 낱말에 ✓ 표시, 거기 있는 줄은 뺀다.

예:
  python3 tools/taste_scan.py ../메모/서가 ../메모/입고기록 --안쪽 ../메모/일기 --이미 ../메모/취향.md
"""
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

신호 = re.compile(r"좋아|좋음|좋다|싫|끌리|끌림|끌려|취향|마음에 들|마음에 안|별로|선호|빠져|재밌|재미있|지루|아쉽|아쉬|최고|못 참|집착|설레|짜증")
날짜이름 = re.compile(r"^(\d{4}-\d{2}-\d{2})")
입고표시 = re.compile(r"\((?:입고|이식)\s*(\d{4}-\d{2}-\d{2})")
낱말꼴 = re.compile(r"[가-힣A-Za-z][가-힣A-Za-z0-9_]+")
조사 = sorted(["으로써", "으로서", "에서는", "에게서", "이라는", "라는", "이라고", "라고", "에서", "에게", "까지", "부터", "처럼",
             "보다", "으로", "하고", "이랑", "랑", "과", "와", "은", "는", "이", "가", "을", "를", "에", "의", "도", "로",
             "만", "들", "께", "한테", "적인", "적", "하는", "했다", "한다", "하기", "해서", "했음", "함", "한", "된", "되는"],
            key=len, reverse=True)
버림 = set("""그리고 그런데 그래서 하지만 그러나 근데 그냥 정말 진짜 너무 아주 조금 많이 하나 이것 저것 그것 이거 저거 그거 여기 거기
있음 없음 있다 없다 있는 없는 하다 되다 같은 같이 같다 때문 대한 위해 통해 경우 정도 이런 저런 그런 어떤 무엇 뭔가 사람 생각 지금 오늘
입고 이식 가안 내용 원문 링크 내가 나는 가장 아직 것이 하지 어떻게 쓰고 싶어 싶음 스스로 하면 하고 되면 때문에 좋아 싫어 별로 다른 되는 이미 사실 것은 하는 만든 만드 말을 아래 함께 보고 대신 아니라 위해서 그림 이후 이전 다시 계속 모두 전부 직접 바로 처음 마지막 한번 이번 다음 하나 두개 우리 자기 자신 사용자 Claude
md http https www com the and for with""".split())


def 줄기(낱말: str) -> str:
    for 끝 in 조사:
        if len(낱말) > len(끝) + 1 and 낱말.endswith(끝):
            return 낱말[: -len(끝)]
    return 낱말


def 낱말들(줄: str) -> list[str]:
    결과 = []
    줄 = re.sub(r"https?://\S+|\([^)]*\.md\)", " ", 입고표시.sub("", 줄))
    for w in 낱말꼴.findall(줄):
        if w in 버림:
            continue
        w = 줄기(w)
        if len(w) >= 2 and w not in 버림 and not w.isdigit():
            결과.append(w)
    return 결과


def 파일모으기(경로들: list[str]) -> list[Path]:
    모음 = []
    for p in 경로들:
        q = Path(p)
        if q.is_file():
            모음.append(q)
        elif q.is_dir():
            모음 += sorted(f for f in q.rglob("*") if f.is_file() and f.suffix in {".md", ".txt"} and ".git" not in f.parts)
        else:
            print(f"없음, 건너뜀: {p}", file=sys.stderr)
    return 모음


def 인자(argv: list[str]):
    칸 = {"바깥": [], "안쪽": [], "이미": [], "부터": None, "낱말": 30, "줄": 60}
    지금 = "바깥"
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--안쪽", "--이미"):
            지금 = a[2:]
        elif a in ("--부터", "--낱말", "--줄"):
            i += 1
            if i >= len(argv):
                raise SystemExit(f"{a} 뒤에 값이 없음")
            칸[a[2:]] = argv[i] if a == "--부터" else int(argv[i])
        elif a.startswith("--"):
            raise SystemExit(f"모르는 선택지: {a} (--help 참고)")
        else:
            칸[지금].append(a)
        i += 1
    return 칸


def main() -> int:
    argv = sys.argv[1:]
    if not argv or "--help" in argv or "-h" in argv:
        print(__doc__)
        return 0
    칸 = 인자(argv)
    부터 = 칸["부터"]

    이미글 = "\n".join(f.read_text(encoding="utf-8", errors="ignore") for f in 파일모으기(칸["이미"]))
    이미낱말 = set(낱말들(이미글))
    이미줄 = {re.sub(r"\s+", " ", 입고표시.sub("", l)).strip(" -") for l in 이미글.splitlines() if l.strip()}

    파일수 = Counter()
    낱말파일 = defaultdict(set)   # 낱말 → 나온 파일들
    낱말수 = Counter()
    안쪽낱말 = set()
    신호줄 = []

    for 쪽 in ("바깥", "안쪽"):
        for f in 파일모으기(칸[쪽]):
            m = 날짜이름.match(f.name)
            if 부터 and m and m.group(1) < 부터:
                continue
            파일수[쪽] += 1
            이름 = f.as_posix()
            for 번호, 줄 in enumerate(f.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
                d = 입고표시.search(줄)
                if 부터 and d and d.group(1) < 부터:
                    continue
                ws = 낱말들(줄)
                for w in ws:
                    낱말파일[w].add(이름)
                    낱말수[w] += 1
                    if 쪽 == "안쪽":
                        안쪽낱말.add(w)
                깨끗 = re.sub(r"\s+", " ", 입고표시.sub("", 줄)).strip(" -")
                if 신호.search(줄) and 깨끗 and 깨끗 not in 이미줄 and not 줄.lstrip().startswith("#"):
                    신호줄.append((쪽, 이름, 번호, 깨끗[:160]))

    print(f"# 취향 훑기 — 바깥 파일 {파일수['바깥']}, 안쪽 파일 {파일수['안쪽']}" + (f", {부터}부터" if 부터 else ""))
    if not 낱말수:
        print("\n훑을 글이 없음.")
        return 0

    print(f"\n## 여러 파일에 되풀이되는 낱말 (파일 수 순, 위 {칸['낱말']}개)")
    print("파일수 | 횟수 | 낱말 | 표시")
    순위 = sorted((w for w in 낱말파일 if len(낱말파일[w]) >= 2), key=lambda w: (-len(낱말파일[w]), -낱말수[w], w))
    for w in 순위[: 칸["낱말"]]:
        표 = []
        if w in 이미낱말:
            표.append("✓이미")
        if w in 안쪽낱말:
            표.append("[안쪽]")
        print(f"{len(낱말파일[w]):>5} | {낱말수[w]:>4} | {w} | {' '.join(표)}")
    if not 순위:
        print("(두 파일 넘게 나온 낱말 없음)")

    print(f"\n## 좋고 싫음이 드러난 줄 (이미 적힌 줄은 뺌, 위 {칸['줄']}개)")
    for 쪽, 이름, 번호, 글 in 신호줄[: 칸["줄"]]:
        print(f"- {'[안쪽] ' if 쪽 == '안쪽' else ''}{이름}:{번호} {글}")
    if len(신호줄) > 칸["줄"]:
        print(f"(그 밖에 {len(신호줄) - 칸['줄']}줄 더 — --줄로 늘린다)")
    if not 신호줄:
        print("(없음)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
