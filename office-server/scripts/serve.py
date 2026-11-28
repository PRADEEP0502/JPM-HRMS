"""JPM HRMS - office server.

Serves the screens (app/dist) and the data server (app/app.py) on ONE port:
  /api/...  -> app.py (Flask)
  anything else -> the built screens (index.html for page links)
Settings come from C:\\JPM-HRMS-PY\\settings.env. Logs go to logs\\app.log (a new file each day, 14 kept).
"""
import base64
import hmac
import json
import logging
import os
import sys
import threading
import time
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from serve_settings import ROOT, load_settings  # noqa: E402

APP_DIR = ROOT / 'app'
DIST = APP_DIR / 'dist'
LOGS = ROOT / 'logs'
LOGS.mkdir(exist_ok=True)

handler = TimedRotatingFileHandler(LOGS / 'app.log', when='midnight', backupCount=14, encoding='utf-8')
handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(name)s: %(message)s'))
logging.basicConfig(level=logging.INFO, handlers=[handler, logging.StreamHandler(sys.stdout)])
log = logging.getLogger('jpm')


for _key, _value in load_settings(ROOT / 'settings.env').items():
    os.environ.setdefault(_key, _value)  # a value already set for this run wins (used only for testing)
_missing = [k for k in ('MONGO_URI', 'APP_USERNAME', 'APP_PASSWORD') if not os.environ.get(k)]
if _missing:
    log.error('%s empty in %s. Fill them in, then restart.', ', '.join(_missing), ROOT / 'settings.env')
    sys.exit(2)
if len(os.environ['APP_PASSWORD']) < 10:
    log.error('APP_PASSWORD in settings.env is too short: use at least 10 characters (the app is on the internet).')
    sys.exit(2)

sys.path.insert(0, str(APP_DIR))
from app import app as api  # noqa: E402  (app.py from the project)
from flask import Flask, send_from_directory  # noqa: E402
from waitress import serve  # noqa: E402

ui = Flask('jpm_ui', static_folder=None)


@ui.route('/', defaults={'path': ''})
@ui.route('/<path:path>')
def screens(path):
    if path and (DIST / path).is_file():
        # Built files have a hash in their name, so browsers may keep them for a long time.
        return send_from_directory(DIST, path, max_age=31536000 if path.startswith('assets/') else 0)
    response = send_from_directory(DIST, 'index.html', max_age=0)
    response.headers['Cache-Control'] = 'no-cache'  # always pick up a new version after an update
    return response


access = logging.getLogger('jpm.access')

# ── LOGIN ────────────────────────────────────────────────────────────────
# Every /api call needs the username + password from settings.env (the sign-in box sends them).
# Exceptions: the health check, and the WhatsApp bot's own calls (checked with WA_BOT_TOKEN in app.py).
OPEN_PATHS = {'/api/health', '/api/whatsapp/pending', '/api/whatsapp/sent', '/api/whatsapp/heartbeat'}
MAX_FAILURES, FAILURE_WINDOW = 10, 15 * 60   # 10 wrong passwords in 15 minutes -> that address waits
_failures = {}
_failures_lock = threading.Lock()


LOOPBACK = ('127.0.0.1', '::1')


def client_address(environ):
    # waitress already replaced REMOTE_ADDR with the real visitor address when the request came
    # through the tunnel on this PC (trusted_proxy below); otherwise it is the office PC's address.
    return environ.get('REMOTE_ADDR', '-')


def credentials_ok(header):
    if not header.startswith('Basic '):
        return False
    try:
        username, _, password = base64.b64decode(header[6:]).decode('utf-8').partition(':')
    except (ValueError, UnicodeDecodeError):
        return False
    good_user = hmac.compare_digest(username.strip().lower().encode(), os.environ['APP_USERNAME'].strip().lower().encode())
    good_pass = hmac.compare_digest(password.encode(), os.environ['APP_PASSWORD'].encode())
    return good_user and good_pass


def deny(start_response, status, message):
    body = json.dumps({'message': message}).encode()
    start_response(status, [('Content-Type', 'application/json'), ('Content-Length', str(len(body)))])
    return [body]


def check_login(environ, start_response):
    """None when the request may continue, otherwise the refusal response."""
    who = client_address(environ)
    now = time.time()
    with _failures_lock:
        recent = [t for t in _failures.get(who, []) if now - t < FAILURE_WINDOW]
        _failures[who] = recent
        if len(recent) >= MAX_FAILURES:
            return deny(start_response, '429 Too Many Requests', 'Too many wrong passwords. Try again in 15 minutes.')
    if credentials_ok(environ.get('HTTP_AUTHORIZATION', '')):
        with _failures_lock:
            _failures.pop(who, None)
        return None
    if who not in LOOPBACK:   # an unknown tunnel visitor is never locked out (would lock out everyone)
        with _failures_lock:
            _failures.setdefault(who, []).append(now)
    log.warning('Wrong or missing login from %s for %s', who, environ.get('PATH_INFO'))
    time.sleep(1.5)  # slows down password guessing
    return deny(start_response, '401 Unauthorized', 'Wrong username or password.')


def dispatch(environ, start_response):
    path = environ.get('PATH_INFO', '')
    target = api if path == '/api' or path.startswith('/api/') else ui
    if target is api and path not in OPEN_PATHS and environ.get('REQUEST_METHOD') != 'OPTIONS':
        refused = check_login(environ, start_response)
        if refused is not None:
            return refused

    def logged_start_response(status, headers, exc_info=None):
        if path.startswith('/api/') and not path.startswith('/api/whatsapp/pending') and not path.startswith('/api/whatsapp/heartbeat'):
            access.info('%s %s %s %s', environ.get('REMOTE_ADDR', '-'), environ.get('REQUEST_METHOD'), path, status.split(' ', 1)[0])
        return start_response(status, headers, exc_info)

    return target(environ, logged_start_response)


if __name__ == '__main__':
    host = os.environ.get('HOST', '0.0.0.0')
    port = int(os.environ.get('PORT', '8081'))
    log.info('JPM HRMS starting on http://%s:%s (screens: %s)', host, port, DIST)
    serve(dispatch, host=host, port=port, threads=8, ident='JPM-HRMS',
          # Requests from the Tailscale Funnel tunnel arrive from this PC; take the visitor's address from it.
          trusted_proxy='127.0.0.1', trusted_proxy_count=1,
          trusted_proxy_headers={'x-forwarded-for'}, clear_untrusted_proxy_headers=True)
