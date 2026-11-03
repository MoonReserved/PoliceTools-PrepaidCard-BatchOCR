"""Native Safari integration check. Requires safaridriver on SAFARI_DRIVER_PORT
and local synthetic fixtures in HEIC_FIXTURE_DIR (never published).
"""
import functools
import http.server
import json
import os
from pathlib import Path
import threading
import urllib.error
import urllib.request

root = Path(__file__).resolve().parent.parent
base = 'http://127.0.0.1:' + os.environ.get('SAFARI_DRIVER_PORT', '4445')
fixtures = Path(os.environ['HEIC_FIXTURE_DIR'])
checks = []
session = None

def request(method, endpoint, value=None):
    data = json.dumps(value).encode() if value is not None else None
    req = urllib.request.Request(base + endpoint, data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    try:
        result = json.load(urllib.request.urlopen(req, timeout=180))['value']
    except urllib.error.HTTPError as e:
        raise RuntimeError(e.read().decode()) from e
    if isinstance(result, dict) and result.get('error'):
        raise RuntimeError(result)
    return result

def execute(script, *args):
    return request('POST', '/session/' + session + '/execute/async', {
        'script': 'const done=arguments[arguments.length-1]; (async()=>{' + script +
                  '})().then(done).catch(e=>done({error:e.message}));', 'args': args})

def payload(file, alias=None, mime=''):
    return {'name': alias or file.name, 'type': mime, 'bytes': list(file.read_bytes())}

def check(name, condition):
    assert condition, name
    checks.append(name)
    print('PASS', name, flush=True)

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=root / 'docs'))
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    value = request('POST', '/session', {'capabilities': {'alwaysMatch': {'browserName': 'safari'}}})
    session = value['sessionId']
    version = value['capabilities']['browserVersion']
    request('POST', '/session/' + session + '/timeouts', {'script': 180000})
    request('POST', '/session/' + session + '/url', {'url': 'http://127.0.0.1:' + str(server.server_port)})
    result = execute('await offlineOCRTest.waitForCache(); window.safariErrors=[]; window.addEventListener("error",e=>safariErrors.push(e.message)); window.testFile=p=>new File([new Uint8Array(p.bytes)],p.name,{type:p.type}); return offlineOCRTest.getState().version;')
    check('Safari loads v8.6.2 and prepares offline assets', result == 'v8.6.2')
    files = ['serial.heic', 'serial-10bit.heic'] + [f'orientation-{i}.heic' for i in range(2, 9)]
    for name in files:
        result = execute('''const f=testFile(arguments[0]); const r=await OfflineImage.prepare(f,await OfflineImage.identify(f));
          const b=await OfflineImage.decode(r.pages[0]);const c=document.createElement('canvas');c.width=b.width;c.height=b.height;
          const ctx=c.getContext('2d');ctx.drawImage(b,0,0);b.close();
          return {size:[c.width,c.height],colours:[[25,25],[c.width-25,25],[25,c.height-25]].map(([x,y])=>[...ctx.getImageData(x,y,1,1).data])};''', payload(fixtures / name))
        assert result.get('size') == [900, 500], result
        r, g, b = result['colours']
        check(name + ': real native HEIC full-size pixels and orientation',
              r[0] > 150 and r[1] < 80 and g[1] > 120 and g[0] < 80 and b[2] > 150 and b[0] < 80)
    for alias, mime in [('PHONE.HEIF', 'application/octet-stream'), ('wrong.jpg', 'image/jpeg')]:
        result = execute('const f=testFile(arguments[0]);const r=await OfflineImage.prepare(f,await OfflineImage.identify(f));return r.pages[0].type;', payload(fixtures / 'serial.heic', alias, mime))
        check('Native HEIC with misleading MIME/name: ' + alias, result == 'image/png')
    result = execute('await offlineOCRTest.addFiles(arguments[0].map(testFile));const s=await offlineOCRTest.whenIdle();return s.files.map(f=>({status:f.status,boxes:f.boxes.length}));', [payload(fixtures / 'serial.heic'), payload(root / 'tests/fixtures/images/pages.tiff')])
    check('Safari HEIC + multipage TIFF import and real detection', isinstance(result, list) and len(result) == 3 and all(f['status'] == 'ready' and f['boxes'] for f in result))
    result = execute('const f=state.files[0];const box=f.boxes.find(b=>b.box[1]>150&&b.box[1]<300);offlineOCRTest.selectBox(f.id,box.id);await offlineOCRTest.whenIdle();return offlineOCRTest.exportTXT();')
    check('Safari real HEIC OCR and export', '12345678901234' in str(result))
    result = execute('await offlineOCRTest.rotateFile(state.files[0].id,1);await offlineOCRTest.whenIdle();return offlineOCRTest.exportTXT();')
    check('Safari HEIC rotation preserves recognition', '12345678901234' in str(result))
    result = execute('await offlineOCRTest.clear();await offlineOCRTest.addFiles([new File(["bad"],"bad.heic"),testFile(arguments[0])]);await offlineOCRTest.whenIdle();return {count:state.files.length,message:document.getElementById("import-warning").textContent};', payload(root / 'tests/fixtures/images/serial.png'))
    check('Safari unreadable HEIC guidance does not block valid PNG', result.get('count') == 1 and all(s in result.get('message', '') for s in ['授權', 'Safari', 'JPG／PNG']))
    check('Safari has no uncaught page errors', execute('return safariErrors;') == [])
    report = {'status': 'pass', 'release': 'v8.6.2', 'browser': 'Safari ' + version,
              'passed': len(checks), 'checks': checks, 'native_heic_tested': True,
              'private_input_published': False, 'physical_iphone_tested': False}
    if os.environ.get('REPORT_PATH'):
        Path(os.environ['REPORT_PATH']).write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
finally:
    if session:
        request('DELETE', '/session/' + session)
    server.shutdown()
