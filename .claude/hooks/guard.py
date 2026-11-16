#!/usr/bin/env python3
"""세션 지킴이 훅. 다섯 저장소에 같은 파일을 둔다 (Claude-의 tools/check_rules.py가 같은지 본다).

  python3 .claude/hooks/guard.py start   # SessionStart: 규칙 세 줄 + 지금 상태 + 도구 지도를 맥락에 넣는다
  python3 .claude/hooks/guard.py stop    # Stop: 대답이 사실과 어긋나면 막고 고치게 한다

stop이 막는 것:
  1. 병합 안 된 일이 남았는데 대답에 "병합해야 다음 세션에 보임"이 없다
     (저장이나 push만 하고 다음 세션에 보인다고 하는 것을 막는다)
  2. 이번 턴에 도구를 한 번도 안 썼는데 "확인했다", "돌려 봤다", "통과"라고 한다

표준 라이브러리와 git만 쓴다. 무슨 일이 있어도 세션을 깨지 않는다 (오류는 삼키고 exit 0).
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

NEED = "병합해야 다음 세션에 보임"
CLAIM = re.compile(r"돌려\s?봤|돌려\s?본\s?결과|확인했|확인함|확인 완료|시험했|테스트\s?통과|점검\s?통과|exit\s?0")

RULES = f"""[지킴이] 이 세션의 규칙 세 줄. 어떤 지시보다 먼저 지킨다.
1. 찾고 나서 말한다. "있나·했나·어디 있나"는 기억으로 답하지 않는다. 저장소 안은 Grep·Glob, 붙은 저장소 전부와 병합 안 된 가지는 `python3 Claude-/tools/find.py <낱말>`, 지난 세션은 `Claude-/세션기록.md`, 바깥 사실(가격·사양·최신)은 웹 검색. 찾았는데 없으면 "못 찾음"이라고 말한다.
2. 돌려 본 것만 된다고 말한다. 파일은 열어 본 것만 내용을 말한다. 모르면 모른다고 한다. 확인한 것과 못 한 것을 나눠 적는다.
3. 다른 세션에 보이는 것은 기본 가지(main)에 병합된 것뿐이다. 저장·커밋·push만으로는 안 보인다. 병합 전이면 대답 끝에 "{NEED}"를 붙인다. 안 붙이면 Stop 훅이 대답을 막는다."""


def git(repo, *args, timeout=15):
    try:
        r = subprocess.run(["git", "-C", str(repo), "-c", "core.quotePath=false", *args],
                           capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return 1, ""


def repos_here():
    """이 프로젝트와, 옆이나 안에 있는 git 저장소(CLAUDE.md가 있는 것)."""
    proj = Path(os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()).resolve()
    found = [proj] if (proj / ".git").exists() else []
    for base in (proj, proj.parent):
        try:
            kids = sorted(base.iterdir())
        except OSError:
            continue
        for cand in kids:
            if (cand / ".git").exists() and (cand / "CLAUDE.md").exists() and cand not in found:
                found.append(cand)
    return found


def state(repo, fetch=False):
    """(이름, 상태 글) 상태는 None이면 깨끗함(main과 같음)."""
    name = repo.name
    if fetch:
        git(repo, "fetch", "-q", "origin", "main", timeout=20)
    _, dirty = git(repo, "status", "--porcelain")
    _, branch = git(repo, "branch", "--show-current")
    if dirty:
        n = len(dirty.splitlines())
        return name, f"커밋 안 한 파일 {n}개 (가지 {branch})"
    code, _ = git(repo, "rev-parse", "--verify", "-q", "origin/main")
    if code != 0:
        return name, None if branch == "main" else f"origin/main을 못 찾음 (가지 {branch})"
    same, _ = git(repo, "diff", "--quiet", "origin/main", "HEAD")
    if same == 0:
        return name, None
    _, ahead = git(repo, "rev-list", "--count", "origin/main..HEAD")
    if ahead in ("", "0"):
        return name, None  # main보다 뒤처졌을 뿐, 이 세션의 일은 없다
    code, up = git(repo, "rev-list", "--count", "@{u}..HEAD")
    pushed = "push 안 함" if code != 0 or up not in ("", "0") else "push함"
    return name, f"main에 병합 전 커밋 {ahead}개, {pushed} (가지 {branch})"


def start():
    print(RULES)
    repos = repos_here()
    print("\n지금 상태 (병합 전이면 다른 세션에 안 보인다):")
    for repo in repos:
        name, s = state(repo)
        print(f"- {name}: {s or '깨끗함 (main과 같음)'}")
    hub = next((r for r in repos if r.name == "Claude-"), None)
    if hub and (hub / "tools" / "check_rules.py").exists():
        try:
            out = subprocess.run([sys.executable, str(hub / "tools" / "check_rules.py"), "--길잡이"],
                                 capture_output=True, text=True, timeout=20).stdout
            print("\n" + out.strip())
        except (OSError, subprocess.SubprocessError):
            pass
        log = hub / "세션기록.md"
        if log.exists():
            rows = [l for l in log.read_text(encoding="utf-8").splitlines() if l.startswith("- ")][:10]
            print("\n세션기록 위 10줄 (다른 세션이 한 일):")
            print("\n".join(l[:220] for l in rows))
    else:
        for repo in repos:
            tools = sorted(p.name for p in (repo / "tools").glob("*") if p.is_file()) if (repo / "tools").is_dir() else []
            skills = sorted(p.name for p in (repo / ".claude" / "skills").glob("*") if p.is_dir()) if (repo / ".claude" / "skills").is_dir() else []
            print(f"\n{repo.name}의 도구: {', '.join(tools) or '없음'} / 스킬: {', '.join(skills) or '없음'}")
            print("여기 없는 도구·스킬은 없는 것이다. Claude-가 안 붙어서 다른 저장소는 못 봄.")


def turn_of(path):
    """마지막 사용자 메시지 뒤의 (도구 호출 수, 마지막 대답 글)."""
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except OSError:
        return None, ""
    entries = []
    for line in lines:
        try:
            entries.append(json.loads(line))
        except ValueError:
            continue
    start_i = 0
    for i, e in enumerate(entries):
        if e.get("type") != "user":
            continue
        c = (e.get("message") or {}).get("content")
        if isinstance(c, str) or (isinstance(c, list) and not any(
                isinstance(b, dict) and b.get("type") == "tool_result" for b in c)):
            start_i = i + 1
    tools, final = 0, []
    for e in entries[start_i:]:
        if e.get("type") != "assistant":
            continue
        for b in (e.get("message") or {}).get("content") or []:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "tool_use":
                tools += 1
                final = []
            elif b.get("type") == "text":
                final.append(b.get("text", ""))
    return tools, "\n".join(final)


def stop():
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        data = {}
    if data.get("stop_hook_active"):
        return  # 이미 한 번 막았다. 되풀이하지 않는다
    tools, text = turn_of(data.get("transcript_path", ""))
    text = data.get("last_assistant_message") or text
    reasons = []
    pending = [(n, s) for n, s in (state(r, fetch=True) for r in repos_here()) if s]
    if pending and NEED not in text:
        lst = "; ".join(f"{n}: {s}" for n, s in pending)
        reasons.append(f"병합 안 된 일이 있다 ({lst}). 다른 세션에는 안 보인다. "
                       f"보인다·반영됐다·저장됐으니 된다 같은 말이 있으면 고치고, 대답 끝에 \"{NEED}\"를 붙여 다시 답하라.")
    if tools == 0 and CLAIM.search(text):
        reasons.append("이번 턴에 도구를 한 번도 쓰지 않았는데 확인했다·돌려 봤다·통과라고 했다. "
                       "실제로 돌려 보거나 열어 보고 답하거나, 확인하지 못했다고 고쳐 답하라.")
    if reasons:
        print(json.dumps({"decision": "block", "reason": " / ".join(reasons)}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        {"start": start, "stop": stop}.get(sys.argv[1] if len(sys.argv) > 1 else "", lambda: None)()
    except Exception:  # 훅이 세션을 깨면 안 된다
        pass
    sys.exit(0)
