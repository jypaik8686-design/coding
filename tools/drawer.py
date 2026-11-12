#!/usr/bin/env python3
"""앱 서랍(맨 위 index.html)을 다시 만든다. 앱 주소로 들어오면 처음 보이는 화면이다.

앱/ 아래 앱마다 이름과 명세의 '한 줄'을 읽어 누르면 열리는 목록으로 만든다.
앱을 더하거나 이름·한 줄을 고쳤으면 다시 돌린다. 자기점검이 낡은 서랍을 잡는다.

  python3 tools/drawer.py
"""
import html
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
빈한줄 = "무엇을 하는 앱인지 한 문장."


def 한줄(앱: Path) -> str:
    """명세.md의 '## 한 줄' 아래 첫 줄. 없거나 틀의 자리표시자 그대로면 빈 글."""
    명세 = 앱 / "명세.md"
    if not 명세.is_file():
        return ""
    m = re.search(r"^## 한 줄\s*\n+([^\n#][^\n]*)", 명세.read_text(encoding="utf-8"), re.M)
    글 = m.group(1).strip() if m else ""
    return "" if 글 == 빈한줄 else 글


def 앱들() -> list[Path]:
    return sorted(d for d in (ROOT / "앱").iterdir() if d.is_dir() and (d / "index.html").is_file())


def 만들기() -> str:
    칸 = []
    for 앱 in 앱들():
        이름 = html.escape(앱.name)
        그림 = f'<img src="앱/{이름}/icon.svg" alt="" width="44" height="44">' if (앱 / "icon.svg").is_file() else '<span class="blank"></span>'
        설명 = html.escape(한줄(앱))
        칸.append(
            f'    <li><a href="앱/{이름}/">{그림}<span class="text"><strong>{이름}</strong>'
            f'{f"<small>{설명}</small>" if 설명 else ""}</span><span class="go" aria-hidden="true">›</span></a></li>'
        )
    목록 = "\n".join(칸) if 칸 else '    <li class="empty">아직 앱이 없음.</li>'
    return f"""<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#101214" media="(prefers-color-scheme: dark)">
<title>앱 서랍</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 64 64%27%3E%3Crect width=%2764%27 height=%2764%27 rx=%2714%27 fill=%27%232f6df6%27/%3E%3Cpath d=%27M16 22h32M16 32h32M16 42h32%27 stroke=%27%23fff%27 stroke-width=%275%27 stroke-linecap=%27round%27/%3E%3C/svg%3E">
<style>
  :root {{ --bg:#ffffff; --card:#f4f5f7; --line:#e2e4e9; --ink:#15171a; --dim:#6b7280; --accent:#2f6df6; }}
  @media (prefers-color-scheme: dark) {{
    :root {{ --bg:#101214; --card:#1a1d21; --line:#2a2e34; --ink:#e9ebee; --dim:#9aa1ab; --accent:#6b9bff; }}
  }}
  * {{ box-sizing: border-box; -webkit-tap-highlight-color: transparent; }}
  body {{
    margin: 0; background: var(--bg); color: var(--ink);
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", system-ui, sans-serif;
    padding: calc(env(safe-area-inset-top) + 28px) max(16px, env(safe-area-inset-right))
             calc(env(safe-area-inset-bottom) + 28px) max(16px, env(safe-area-inset-left));
  }}
  h1 {{ margin: 0 0 4px; font-size: 22px; letter-spacing: -0.02em; }}
  p {{ margin: 0 0 20px; color: var(--dim); font-size: 14px; }}
  ul {{ list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; max-width: 560px; }}
  a {{
    display: flex; align-items: center; gap: 14px; min-height: 68px; padding: 12px 14px;
    background: var(--card); border: 1px solid var(--line); border-radius: 16px;
    color: inherit; text-decoration: none;
  }}
  a:focus-visible {{ outline: 2px solid var(--accent); outline-offset: 2px; }}
  img, .blank {{ width: 44px; height: 44px; flex: none; border-radius: 11px; background: var(--line); }}
  .text {{ flex: 1; min-width: 0; display: grid; }}
  strong {{ font-size: 17px; font-weight: 650; }}
  small {{ color: var(--dim); font-size: 13px; overflow-wrap: anywhere; }}
  .go {{ color: var(--dim); font-size: 22px; }}
  .empty {{ color: var(--dim); padding: 32px 0; text-align: center; }}
</style>
</head>
<body>
  <h1>앱 서랍</h1>
  <p>눌러서 연다. 홈 화면에 추가해 두면 앱처럼 열린다.</p>
  <ul>
{목록}
  </ul>
</body>
</html>
"""


def main() -> int:
    if "--help" in sys.argv or "-h" in sys.argv:
        print(__doc__)
        return 0
    (ROOT / "index.html").write_text(만들기(), encoding="utf-8")
    표시 = ROOT / ".nojekyll"  # 올린 파일을 손대지 않고 그대로 내보내게 한다
    if not 표시.exists():
        표시.write_text("", encoding="utf-8")
    이름들 = [a.name for a in 앱들()]
    print(f"서랍 다시 만듦: index.html — 앱 {len(이름들)}개 ({', '.join(이름들) or '없음'})")
    빈 = [a.name for a in 앱들() if not 한줄(a)]
    if 빈:
        print(f"명세의 '한 줄'이 비어 있는 앱: {', '.join(빈)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
