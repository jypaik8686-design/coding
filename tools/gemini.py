#!/usr/bin/env python3
"""길고 단순한 일을 제미니에 넘긴다. 결과만 받아 온다. 설치할 것 없음(표준 라이브러리).

  export GEMINI_API_KEY=...            # https://aistudio.google.com/apikey
  python3 tools/gemini.py "이 문구 영어로"
  cat 긴글.md | python3 tools/gemini.py --시스템 "한 줄 요약만"
  python3 tools/gemini.py --파일 명세.md "여기서 빠진 화면 찾아"
  python3 tools/gemini.py --각줄 --시스템 "감정만 한 단어로" < 문장들.txt
  python3 tools/gemini.py --예행 "확인"        # 안 보내고 보낼 것만 보여준다
"""
import argparse
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HOST = "https://generativelanguage.googleapis.com/v1beta"
# 2026-11-12 공식 모델 목록(ai.google.dev/gemini-api/docs/models)에서 대량·저가용으로 적힌 것.
# 모델 이름은 내려간다. HTTP 404가 나오면 목록을 다시 보고 --모델 로 바꾼다.
기본모델 = "gemini-3.5-flash-lite"
CA = ["SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"]


def 열쇠() -> str:
    for n in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
        if os.environ.get(n):
            return os.environ[n]
    sys.exit(
        "GEMINI_API_KEY 없음.\n"
        "  https://aistudio.google.com/apikey 에서 받아서\n"
        "  export GEMINI_API_KEY=...  하고 다시."
    )


def ssl맥락() -> ssl.SSLContext:
    # 프록시 뒤에서도 검증은 켜 둔다. 번들 위치만 찾아 준다.
    for n in CA:
        p = os.environ.get(n)
        if p and Path(p).is_file():
            return ssl.create_default_context(cafile=p)
    기본 = Path("/root/.ccr/ca-bundle.crt")
    if 기본.is_file():
        return ssl.create_default_context(cafile=str(기본))
    return ssl.create_default_context()


def 부르기(모델: str, 프롬프트: str, 시스템: str | None, 온도: float, 키: str) -> dict:
    몸통: dict = {
        "contents": [{"role": "user", "parts": [{"text": 프롬프트}]}],
        "generationConfig": {"temperature": 온도},
    }
    if 시스템:
        몸통["systemInstruction"] = {"parts": [{"text": 시스템}]}

    req = urllib.request.Request(
        f"{HOST}/models/{모델}:generateContent",
        data=json.dumps(몸통).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": 키},
        method="POST",
    )
    맥락 = ssl맥락()
    마지막 = ""
    for 번 in range(4):
        try:
            with urllib.request.urlopen(req, timeout=120, context=맥락) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            몸 = e.read().decode("utf-8", "replace")[:400]
            마지막 = f"HTTP {e.code} {몸}"
            if e.code in (429, 500, 502, 503, 504) and 번 < 3:
                time.sleep(2 ** 번)
                continue
            sys.exit(f"제미니가 거절함: {마지막}")
        except urllib.error.URLError as e:
            마지막 = str(e.reason)
            if 번 < 3:
                time.sleep(2 ** 번)
                continue
            sys.exit(f"제미니에 못 닿음: {마지막}\n(프록시 뒤라면 generativelanguage.googleapis.com 이 허용돼 있는지 확인)")
    sys.exit(f"실패: {마지막}")


def 글만(res: dict) -> str:
    후보 = (res.get("candidates") or [{}])[0]
    조각 = (후보.get("content") or {}).get("parts") or []
    글 = "".join(p.get("text", "") for p in 조각).strip()
    if not 글:
        이유 = 후보.get("finishReason") or (res.get("promptFeedback") or {}).get("blockReason") or "모름"
        return f"[빈 답 — {이유}]"
    return 글


def main() -> int:
    ap = argparse.ArgumentParser(description="제미니에 일 넘기기")
    ap.add_argument("프롬프트", nargs="*", help="시킬 일. 없으면 표준입력을 읽는다")
    ap.add_argument("--모델", default=기본모델, help=f"기본 {기본모델}")
    ap.add_argument("--시스템", help="말투·규칙 같은 앞세울 지시")
    ap.add_argument("--파일", action="append", default=[], help="프롬프트에 붙일 파일 (여러 번 가능)")
    ap.add_argument("--온도", type=float, default=0.4)
    ap.add_argument("--각줄", action="store_true", help="표준입력 한 줄마다 따로 물어보고 TSV로 뱉는다")
    ap.add_argument("--json", action="store_true", help="응답 원본 그대로")
    ap.add_argument("--예행", action="store_true", help="보내지 않고 보낼 것만 보여준다")
    a = ap.parse_args()

    말 = " ".join(a.프롬프트).strip()
    붙임 = []
    for f in a.파일:
        p = Path(f)
        if not p.is_file():
            sys.exit(f"그런 파일 없음: {f}")
        붙임.append(f"--- {p.name} ---\n{p.read_text(encoding='utf-8')}")

    if a.각줄:
        줄들 = [l.strip() for l in sys.stdin.read().splitlines() if l.strip()]
        if not 줄들:
            sys.exit("표준입력이 비었음")
        if a.예행:
            print(f"[예행] {a.모델} 에 {len(줄들)}번 물어봄. 첫 줄: {줄들[0][:60]}")
            return 0
        키 = 열쇠()
        for 줄 in 줄들:
            답 = 글만(부르기(a.모델, f"{말}\n\n{줄}".strip(), a.시스템, a.온도, 키))
            print(f"{줄}\t{답.replace(chr(9), ' ').splitlines()[0] if 답 else ''}")
        return 0

    선 = sys.stdin.read().strip() if not sys.stdin.isatty() else ""
    프롬프트 = "\n\n".join(x for x in [말, *붙임, 선] if x)
    if not 프롬프트:
        sys.exit("시킬 일이 없음. 인자나 표준입력으로 주세요.")

    if a.예행:
        print(f"[예행] 모델 {a.모델}, 온도 {a.온도}, 시스템 {'있음' if a.시스템 else '없음'}")
        print(f"[예행] 글자 {len(프롬프트)}자\n--- 보낼 것 (앞 500자) ---\n{프롬프트[:500]}")
        return 0

    res = 부르기(a.모델, 프롬프트, a.시스템, a.온도, 열쇠())
    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    else:
        print(글만(res))
        쓴것 = res.get("usageMetadata") or {}
        if 쓴것:
            print(
                f"\n[{a.모델} · 들어간 토큰 {쓴것.get('promptTokenCount', '?')}"
                f" · 나온 토큰 {쓴것.get('candidatesTokenCount', '?')}]",
                file=sys.stderr,
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
