"""Exercise the real SMB audit path, including authentication and denied writes."""
import io
import sys
from impacket.smbconnection import SMBConnection, SessionError

port = int(sys.argv[1])
client = SMBConnection('127.0.0.1', '127.0.0.1', sess_port=port)
client.login('writer', 'test-password')
client.putFile('Files', 'smb-upload.txt', io.BytesIO(b'private-file-content').read)
client.getFile('Files', 'smb-upload.txt', lambda data: None)
client.rename('Files', 'smb-upload.txt', 'smb-renamed.txt')
client.deleteFile('Files', 'smb-renamed.txt')
client.close()
reader = SMBConnection('127.0.0.1', '127.0.0.1', sess_port=port)
reader.login('reader', 'test-password')
try:
    reader.putFile('Files', 'smb-denied.txt', io.BytesIO(b'no').read)
    raise AssertionError('Read-only upload succeeded')
except SessionError:
    pass
reader.close()
bad = SMBConnection('127.0.0.1', '127.0.0.1', sess_port=port)
try:
    bad.login('writer', 'wrong-password')
    raise AssertionError('Wrong password accepted')
except SessionError:
    pass
bad.close()
