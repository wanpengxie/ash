# Controlled local metadata-only WebSocket peer. No native model or shell action.
import base64, hashlib, json, os, select, socket, struct, sys
path, cwd = sys.argv[1:3]
listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
listener.bind(path)
listener.listen(16)
connections = []
buffers = {}
upgraded = set()
deleted = False
print(json.dumps({'ready': True}), flush=True)
def frame(value):
    payload = json.dumps(value).encode()
    return b'\x81' + (bytes([len(payload)]) if len(payload)<126 else b'\x7e'+struct.pack('!H',len(payload))) + payload
while True:
    read, _, _ = select.select([listener, sys.stdin] + connections, [], [], 1)
    for s in read:
        if s == sys.stdin:
            line = sys.stdin.readline()
            if not line: sys.exit(0)
            change = json.loads(line)
            cwd = change.get('cwd', cwd)
            deleted = change.get('deleted', deleted)
            continue
        if s == listener:
            c, _ = listener.accept()
            connections.append(c)
            buffers[c] = b''
            continue
        chunk = s.recv(65536)
        if not chunk:
            connections.remove(s); buffers.pop(s, None); upgraded.discard(s); s.close(); continue
        buffers[s] += chunk
        if s not in upgraded:
            if b'\r\n\r\n' not in buffers[s]: continue
            headers, buffers[s] = buffers[s].split(b'\r\n\r\n', 1)
            key = next(line.split(b':',1)[1].strip() for line in headers.split(b'\r\n') if line.lower().startswith(b'sec-websocket-key:'))
            accept = base64.b64encode(hashlib.sha1(key+b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest())
            s.sendall(b'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+b'\r\n\r\n')
            upgraded.add(s)
        while len(buffers[s])>=2:
            b = buffers[s]
            size = b[1]&127; offset = 2
            if size==126:
                if len(b)<4: break
                size=struct.unpack('!H',b[2:4])[0]; offset=4
            elif size==127:
                if len(b)<10: break
                size=struct.unpack('!Q',b[2:10])[0]; offset=10
            if size>65536: sys.exit(2)
            if len(b)<offset+4+size: break
            mask=b[offset:offset+4]; offset+=4
            payload=bytes(v^mask[i%4] for i,v in enumerate(b[offset:offset+size]))
            buffers[s]=b[offset+size:]
            if b[0]&15==8:
                s.sendall(b'\x88\x00'); break
            if b[0]&15!=1: continue
            request=json.loads(payload)
            print(json.dumps({'call':request}),flush=True)
            if 'id' not in request: continue
            method=request['method']
            if method=='initialize': result={'userAgent':'controlled metadata fixture '+'.'.join(map(str,sys.version_info[:3]))}
            elif method=='thread/read': result={'thread':{'id':'deleted' if deleted else 'exact-thread','cwd':cwd}}
            else: sys.exit(3)
            s.sendall(frame({'id':request['id'],'result':result}))
