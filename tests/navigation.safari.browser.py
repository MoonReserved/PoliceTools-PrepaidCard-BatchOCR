"""Safari Back protection check using synthetic local data and a dedicated WebDriver window.
Start safaridriver separately; SAFARI_DRIVER_PORT defaults to 4457.
"""
import functools
import http.server
import json
import os
from pathlib import Path
import threading
import time
import urllib.error
import urllib.request

root = Path(__file__).resolve().parent.parent
base = 'http://127.0.0.1:' + os.environ.get('SAFARI_DRIVER_PORT', '4457')
session = None
checks = []


def request(method, endpoint, value=None):
    data = json.dumps(value).encode() if value is not None else None
    req = urllib.request.Request(base + endpoint, data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    try:
        result = json.load(urllib.request.urlopen(req, timeout=120))['value']
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode()) from error
    if isinstance(result, dict) and result.get('error'):
        raise RuntimeError(result)
    return result


def command(method, endpoint, value=None):
    return request(method, '/session/' + session + endpoint, value)


def js(script, *args):
    return command('POST', '/execute/sync', {'script': script, 'args': args})


def wait(script):
    until = time.monotonic() + 30
    while time.monotonic() < until:
        if js(script):
            return
        time.sleep(.1)
    raise AssertionError('Timed out: ' + script)


def click(selector):
    element = command('POST', '/element', {'using': 'css selector', 'value': selector})
    key = 'element-6066-11e4-a52e-4f735466cecf'
    if selector == '#cache-status':
        command('POST', '/element/' + element[key] + '/click', {})
    else:
        # SafariDriver pointer coordinates ignore an existing Safari page zoom.
        # Focus + native Enter tests the real handlers without changing user settings.
        js('document.querySelector(arguments[0]).focus();', selector)
        command('POST', '/element/' + element[key] + '/value', {'text': '\ue007', 'value': ['\ue007']})


def check(name, condition):
    assert condition, name
    checks.append(name)
    print('PASS', name, flush=True)


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=root / 'docs'))
threading.Thread(target=server.serve_forever, daemon=True).start()
url = 'http://127.0.0.1:' + str(server.server_port) + '/'
try:
    value = request('POST', '/session', {'capabilities': {'alwaysMatch': {'browserName': 'safari', 'unhandledPromptBehavior': 'ignore'}}})
    session = value['sessionId']
    version = value['capabilities']['browserVersion']
    command('POST', '/timeouts', {'script': 30000, 'pageLoad': 30000})
    command('POST', '/url', {'url': url + 'review-guide.html'})
    command('POST', '/url', {'url': url})
    wait('return typeof offlineOCRTest !== "undefined";')
    check('Initial notice is visible directly below offline status', js('const e=document.getElementById("leave-warning");return !e.hidden && e.previousElementSibling.id==="cache-status";'))
    click('#cache-status')
    # Add a public synthetic fixture; pause OCR since this suite tests navigation only.
    fixture = list((root / 'tests/fixtures/images/serial.png').read_bytes())
    js('offlineOCRTest.pause();window.testImport=offlineOCRTest.addFiles([new File([new Uint8Array(arguments[0])],"synthetic.png",{type:"image/png"})]);', fixture)
    wait('return state.files.length===1&&!state.importPending;')
    length = js('return history.length;')
    for attempt in range(3):
        command('POST', '/back', {})
        wait('return document.getElementById("leave-dialog").open && !backGuard.restoring;')
        click('#stay-on-page')
        wait('return !document.getElementById("leave-dialog").open;')
        actual=js('return {files:state.files.length,open:document.getElementById("leave-dialog").open,length:history.length,marker:history.state,restoring:backGuard.restoring};')
        check('Safari Back / Stay preserves the image without growing history: ' + str(attempt+1),actual['files']==1 and not actual['open'] and actual['length']==length)
    click('#clear')
    wait('return state.files.length===0;')
    command('POST', '/back', {})
    wait('return document.getElementById("leave-dialog").open && !backGuard.restoring;')
    click('#stay-on-page')
    click('#undo')
    check('Safari Back also protects cleared but recoverable data', js('return state.files.length===1;'))
    command('POST', '/back', {})
    wait('return document.getElementById("leave-dialog").open && !backGuard.restoring;')
    click('#leave-page')
    wait('return location.pathname.endsWith("review-guide.html");')
    check('Confirming Leave reaches the actual previous page', command('GET', '/url') == url+'review-guide.html')
    command('POST', '/forward', {})
    wait('return typeof offlineOCRTest !== "undefined";')
    check('Forward restoration keeps at most one guard step', js('return history.length<=arguments[0];', length))
    # A freshly reloaded empty page must skip the old guard without a warning.
    command('POST', '/refresh', {})
    wait('return typeof offlineOCRTest !== "undefined" && state.files.length===0;')
    command('POST', '/back', {})
    wait('return location.pathname.endsWith("review-guide.html");')
    check('An empty reloaded page can go Back without a warning or duplicate stop', True)
    report = {'status': 'pass', 'release': 'v8.7.1', 'browser': 'Safari ' + version, 'passed': len(checks), 'checks': checks,
              'scope': 'Dedicated native Safari WebDriver window; synthetic PNG; browser history Back/Forward, Stay/Leave, clear/undo and reload.'}
    if os.environ.get('REPORT_PATH'):
        Path(os.environ['REPORT_PATH']).write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps(report))
finally:
    if session:
        request('DELETE', '/session/'+session)
    server.shutdown()
