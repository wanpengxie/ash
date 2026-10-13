# Synthetic saved history only. Opens the selected isolated SQLite fixture FD;
# native socket writes this history from its actual received create/control RPCs.
import json, os, sys
if sys.argv[1:]==['--version']:
    print('codex-cli 0.0.1');sys.exit(0)
args=sys.argv[1:];realm=None
if len(args)==4 and args[0]=='-c' and args[1].startswith('sqlite_home='):
    realm=json.loads(args[1].split('=',1)[1]);args=args[2:]
if args!=['app-server','--stdio']:sys.exit(2)
home=os.environ['CODEX_HOME'];database_fd=open(os.path.join(realm or home,'state_5.sqlite'),'rb')
with open(os.path.join(home,'history-path')) as f: history_path=f.read().strip()
for line in sys.stdin:
    frame=json.loads(line);method=frame.get('method')
    if method=='initialized':continue
    with open(history_path) as f: history=json.load(f)
    if method=='initialize':result={'userAgent':'codex-cli/0.0.1'}
    elif method=='thread/list':result={'data':[{'id':'android-new-thread','cwd':history['cwd'],'name':'Android project conversation','updatedAt':1}] if history['created'] else [],'nextCursor':None}
    elif method=='thread/read':result={'thread':{'id':'android-new-thread','cwd':history['cwd']}}
    elif method=='thread/turns/list':result={'data':list(reversed(history['turns'])),'nextCursor':None}
    else:sys.exit(3)
    print(json.dumps({'jsonrpc':'2.0','id':frame['id'],'result':result}),flush=True)
