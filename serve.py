"""Quick local preview: run `python3 serve.py` from this folder and open http://localhost:8791"""
import http.server
import socketserver
import os

os.chdir(os.path.dirname(os.path.abspath(__file__)))

PORT = 8791
Handler = http.server.SimpleHTTPRequestHandler

with socketserver.TCPServer(("", PORT), Handler) as httpd:
    httpd.allow_reuse_address = True
    print(f"Serving Mambo Team Hub at http://localhost:{PORT}")
    httpd.serve_forever()
