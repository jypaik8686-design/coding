#!/usr/bin/env python3
"""폰 웹앱을 로컬에서 띄운다. 캐시 없음, 없는 주소는 index.html로 보낸다.

  python3 tools/serve.py 앱/할일          # 8000번
  python3 tools/serve.py 앱/할일 -p 8080
  python3 tools/serve.py 앱/할일 --조용히 &   # 뒤로 돌리고 스크린샷 찍을 때
"""
import argparse
import functools
import http.server
import os
import socket
import socketserver
import sys
from pathlib import Path

MIME = {
    ".mjs": "text/javascript",
    ".js": "text/javascript",
    ".webmanifest": "application/manifest+json",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    quiet = False

    def end_headers(self):
        # 고친 게 바로 보이게. 폰 웹앱은 캐시가 제일 헷갈린다.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Service-Worker-Allowed", "/")
        super().end_headers()

    def guess_type(self, path):
        ext = Path(str(path)).suffix.lower()
        return MIME.get(ext) or super().guess_type(path)

    def send_head(self):
        # 해시 라우터가 아닌 주소로 바로 들어와도 앱이 뜨게 한다.
        path = self.translate_path(self.path)
        if not os.path.exists(path) and not Path(path).suffix:
            self.path = "/index.html"
        return super().send_head()

    def log_message(self, fmt, *args):
        if not self.quiet:
            super().log_message(fmt, *args)


def free_port(start: int, tries: int = 20) -> int:
    for p in range(start, start + tries):
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", p)) != 0:
                return p
    raise SystemExit(f"{start}번부터 {tries}개가 다 쓰이고 있음")


def main() -> int:
    ap = argparse.ArgumentParser(description="폰 웹앱 로컬 서버")
    ap.add_argument("dir", nargs="?", default=".", help="띄울 폴더 (기본: 지금 폴더)")
    ap.add_argument("-p", "--port", type=int, default=8000)
    ap.add_argument("--조용히", action="store_true", help="요청 줄을 찍지 않는다")
    a = ap.parse_args()

    root = Path(a.dir).resolve()
    if not root.is_dir():
        print(f"폴더 없음: {root}", file=sys.stderr)
        return 1
    if not (root / "index.html").is_file():
        print(f"index.html 없음: {root}", file=sys.stderr)
        return 1

    port = free_port(a.port)
    Handler.quiet = a.조용히
    handler = functools.partial(Handler, directory=str(root))
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", port), handler) as srv:
        print(f"떴음  http://127.0.0.1:{port}/   ({root})")
        print(f"스크린샷: node tools/shot.mjs http://127.0.0.1:{port}/ --out 화면/지금.png")
        print("끌 때는 Ctrl+C")
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print("\n껐음")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
