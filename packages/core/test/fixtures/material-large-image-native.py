# Explicit synthetic near-4MiB delayed input consumption peer. No model, shell or installed native runtime.
import base64, hashlib, json, os, select, socket, struct, sys
path, cwd = sys.argv[1:3]
listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
listener.bind(path)
listener.listen(16)
connections = []
buffers = {}
upgraded = set()
deleted = False
turn_count = 0
last_turn = None
pending_images = []
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
            if change.get('complete_turn'):
                if last_turn is None: sys.exit(4)
                for image_path, expected in pending_images:
                    fd = os.open(image_path, os.O_RDONLY | os.O_NOFOLLOW)
                    try:
                        stat = os.fstat(fd)
                        if (stat.st_dev, stat.st_ino, stat.st_size) != expected: sys.exit(5)
                        pieces = []
                        while True:
                            piece = os.read(fd, 65536)
                            if not piece: break
                            pieces.append(piece)
                        image = b''.join(pieces)
                        after = os.fstat(fd)
                        if (after.st_dev, after.st_ino, after.st_size) != expected: sys.exit(6)
                        print(json.dumps({'image':{'sha256':hashlib.sha256(image).hexdigest(),'byte_length':len(image),'dev':str(stat.st_dev),'ino':str(stat.st_ino),'delayed':True}}),flush=True)
                    finally: os.close(fd)
                pending_images.clear()
                for connection in list(upgraded):
                    connection.sendall(frame({'method':'turn/started','params':{'threadId':'exact-thread','turn':{'id':last_turn}}}))
                    connection.sendall(frame({'method':'turn/completed','params':{'threadId':'exact-thread','turn':{'id':last_turn,'status':'completed'}}}))
                print(json.dumps({'completed':change['complete_turn']}),flush=True)
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
            elif method in ('thread/read','thread/resume'): result={'thread':{'id':'deleted' if deleted else 'exact-thread','cwd':cwd,'status':{'type':'idle'}}}
            elif method=='turn/start':
                for item in request['params']['input']:
                    if item['type']=='localImage':
                        stat = os.stat(item['path'], follow_symlinks=False)
                        pending_images.append((item['path'], (stat.st_dev, stat.st_ino, stat.st_size)))
                turn_count += 1
                last_turn = 'synthetic-accepted-turn-' + str(turn_count)
                result={'turn':{'id':last_turn}}
            else: sys.exit(3)
            s.sendall(frame({'id':request['id'],'result':result}))
