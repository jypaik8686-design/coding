# coding

폰 웹앱을 만들기 위한 도구함. 규칙은 [CLAUDE.md](CLAUDE.md), 있는 것 전부는 [도구목록.md](도구목록.md).

## 새 세션에서

이 저장소 하나만 고르면 된다. 다른 저장소는 필요 없다. 세션이 시작되면 규칙과 스킬이 저절로 읽힌다.

```bash
python3 tools/ready.py                   # 이 세션에서 실제로 되는 것을 돌려 본다
python3 tools/new_app.py 가계부           # 깐다
python3 tools/serve.py 앱/가계부 --조용히 & # 띄운다
node tools/shot.mjs http://127.0.0.1:8000/ --out 화면/가계부.png   # 찍는다
python3 tools/check_toolbox.py           # 어긋난 데 없는지 본다
```

저장소에 들어 있지 않은 것은 제미니 열쇠 하나다. 클라우드 환경 설정의 네트워크 비밀에 호스트 `generativelanguage.googleapis.com`, 헤더 `x-goog-api-key`로 한 번 넣어 두면 그 환경의 모든 세션에서 쓴다.

세션에서 고친 것은 기본 가지에 병합돼야 다음 세션이 받는다.
