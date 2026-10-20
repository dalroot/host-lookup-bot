#!/usr/bin/env python3
import http.server
import socketserver
import requests
import sys

TARGET_HOST = "https://cloud.telegram.org"
SOCKS_PROXY = "socks5h://127.0.0.1:10808"
PORT = 19090

class ThreadingTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True

class ProxyHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        sys.stderr.write(f"[bridge] {self.command} {self.path} -> ")

    def do_request(self):
        url = f"{TARGET_HOST}{self.path}"
        headers = {k: v for k, v in self.headers.items() if k.lower() not in ('host', 'content-length')}
        content_len = int(self.headers.get('content-length', 0))
        body = self.rfile.read(content_len) if content_len > 0 else None

        try:
            resp = requests.request(
                method=self.command,
                url=url,
                headers=headers,
                data=body,
                proxies={"https": SOCKS_PROXY, "http": SOCKS_PROXY},
                timeout=30,
                allow_redirects=False
            )
            self.send_response(resp.status_code)
            for k, v in resp.headers.items():
                if k.lower() not in ('transfer-encoding', 'content-encoding', 'content-length'):
                    self.send_header(k, v)
            self.send_header('Content-Length', str(len(resp.content)))
            self.end_headers()
            self.wfile.write(resp.content)
            sys.stderr.write(f"{resp.status_code}\n")
        except Exception as e:
            sys.stderr.write(f"ERR: {e}\n")
            try:
                self.send_error(502, f"Proxy Bridge Error: {e}")
            except Exception:
                pass

    do_GET = do_request
    do_POST = do_request
    do_PUT = do_request
    do_DELETE = do_request
    do_PATCH = do_request

if __name__ == '__main__':
    with ThreadingTCPServer(("127.0.0.1", PORT), ProxyHandler) as httpd:
        print(f"Bridge listening on 127.0.0.1:{PORT} routing to {TARGET_HOST} via {SOCKS_PROXY}", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
