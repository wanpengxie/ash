# Synthetic saved-history stdio fixture. Uses only its test CODEX_HOME.
import json, os, signal, subprocess, sys, time
if sys.argv[1:] == ['--version']:
    print('codex-cli 0.0.1')
    sys.exit(0)
args = sys.argv[1:]
realm = None
if len(args) == 4 and args[0] == '-c' and args[1].startswith('sqlite_home='):
    realm = json.loads(args[1].split('=', 1)[1])
    args = args[2:]
if args != ['app-server', '--stdio']:
    sys.exit(2)
home = os.environ['CODEX_HOME']
database_fd = open(os.path.join(realm or home, 'state_5.sqlite'), 'rb')
def mode():
    try:
        with open(os.path.join(home, 'fixture-mode')) as f:
            return f.read().strip()
    except FileNotFoundError:
        return ''
def terminate(*args):
    if mode() == 'drain-config':
        with open(os.path.join(home, 'config.toml'), 'a') as f:
            f.write('\n# synthetic change\n')
    if mode() == 'drain-replace':
        source = os.path.join(os.path.dirname(home), 'state', 'collaboration-read-runtime.json')
        with open(source, 'rb') as f:
            raw = f.read()
        with open(source + '.new', 'wb') as f:
            f.write(raw)
        os.chmod(source + '.new', 0o600)
        os.replace(source + '.new', source)
    sys.exit(0)
signal.signal(signal.SIGTERM, signal.SIG_IGN if mode() == 'ignore-term' else terminate)
for line in sys.stdin:
    frame = json.loads(line)
    method = frame.get('method')
    with open(os.path.join(home, 'fixture-methods'), 'a') as f:
        f.write(str(method) + '\n')
    if method == 'initialized':
        if mode() == 'escape-pipe':
            holder = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], start_new_session=True)
            with open(os.path.join(home, 'fixture-pipe-holder'), 'w') as f:
                f.write(str(holder.pid))
        continue
    if method == 'initialize':
        result = {'userAgent': 'codex-cli/0.0.1'}
    elif method == 'thread/list':
        p = frame['params']
        if p.get('limit') != 1 or p.get('useStateDbOnly') is not True:
            sys.exit(3)
        if mode() == 'hold':
            time.sleep(60)
        if mode() == 'response-config':
            with open(os.path.join(home, 'config.toml'), 'a') as f:
                f.write('\n# synthetic change\n')
        if mode() == 'replace':
            source = os.path.join(os.path.dirname(home), 'state', 'collaboration-read-runtime.json')
            with open(source, 'rb') as f:
                raw = f.read()
            with open(source + '.new', 'wb') as f:
                f.write(raw)
            os.chmod(source + '.new', 0o600)
            os.replace(source + '.new', source)
        result = {'data': [] if mode() == 'empty' else [{'id': 'synthetic-id', 'cwd': '/invalid' if mode() == 'wrong-cwd' else p['cwd'][0], 'name': 'PRIVATE SYNTHETIC NAME', 'preview': 'PRIVATE SYNTHETIC PREVIEW'}], 'nextCursor': None}
    else:
        sys.exit(4)
    print(json.dumps({'jsonrpc': '2.0', 'id': frame['id'], 'result': result}), flush=True)
