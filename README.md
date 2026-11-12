# coding

폰 웹앱을 만들기 위한 도구함. 규칙은 [CLAUDE.md](CLAUDE.md), 있는 것 전부는 [도구목록.md](도구목록.md).

```bash
python3 tools/new_app.py 할일            # 깐다
python3 tools/serve.py 앱/할일 --조용히 & # 띄운다
node tools/shot.mjs http://127.0.0.1:8000/ --out 화면/할일.png   # 찍는다
python3 tools/check_toolbox.py           # 어긋난 데 없는지 본다
```
