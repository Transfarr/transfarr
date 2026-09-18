"""Real SMB client coverage for the metadata streams used by Apple Files."""
import io
import struct
import sys
from impacket.smbconnection import SMBConnection, SessionError
from impacket.smb3 import SessionError as SMB3SessionError
from impacket.smb3structs import (
    FILE_READ_DATA, FILE_READ_ATTRIBUTES,
    FILE_OPEN, FILE_DIRECTORY_FILE, SMB2_0_INFO_FILESYSTEM,
)

port, phase = int(sys.argv[1]), sys.argv[2]
client = SMBConnection('127.0.0.1', '127.0.0.1', sess_port=port)
client.getSMBServer()._Connection['RequireSigning'] = True
client.login('writer', 'test-password')
tree = client.connectTree('Files')
smb = client.getSMBServer()
assert smb._Session['SigningActivated']
root = client.openFile(tree, '', desiredAccess=FILE_READ_ATTRIBUTES, creationOption=FILE_DIRECTORY_FILE, creationDisposition=FILE_OPEN)
attributes = smb.queryInfo(tree, root, infoType=SMB2_0_INFO_FILESYSTEM, fileInfoClass=5)
assert struct.unpack_from('<I', attributes)[0] & 0x00040000, 'FILE_NAMED_STREAMS missing'
client.closeFile(tree, root)
metadata = b'ios-metadata\x00\x01\x02'

if phase == 'write':
    for base in ['base.txt', 'folder', '']:
        stream = base + ':com.apple.lastuseddate#PS:$DATA'
        client.putFile('Files', stream, io.BytesIO(metadata).read)
        received = bytearray()
        client.getFile('Files', stream, received.extend)
        assert received == metadata
        base_id = client.openFile(tree, base, desiredAccess=FILE_READ_ATTRIBUTES, creationOption=0, creationDisposition=FILE_OPEN)
        listing = smb.queryInfo(tree, base_id, fileInfoClass=22)
        streams = {}
        offset = 0
        while offset < len(listing):
            next_entry, name_length, size, allocation = struct.unpack_from('<IIQQ', listing, offset)
            name = listing[offset + 24:offset + 24 + name_length].decode('utf-16le')
            streams[name] = size
            if not next_entry:
                break
            assert next_entry % 8 == 0
            offset += next_entry
        assert streams[':com.apple.lastuseddate#PS:$DATA'] == len(metadata)
        client.closeFile(tree, base_id)
    # A failed stream probe must never escape confinement.
    for stream in ['escape/secret.txt:meta', '../secret.txt:meta']:
        try:
            client.putFile('Files', stream, io.BytesIO(b'no').read)
            raise AssertionError('Stream escaped the share')
        except SessionError:
            pass
    client.rename('Files', 'base.txt', 'renamed.txt')
else:
    for base in ['renamed.txt', 'folder', '']:
        received = bytearray()
        client.getFile('Files', base + ':COM.APPLE.LASTUSEDDATE#PS:$DATA', received.extend)
        assert received == metadata, 'Stream lost after server restart/base rename'

reader = SMBConnection('127.0.0.1', '127.0.0.1', sess_port=port)
reader.getSMBServer()._Connection['RequireSigning'] = True
reader.login('reader', 'test-password')
reader_tree = reader.connectTree('Files')
received = bytearray()
reader.getFile('Files', 'renamed.txt:com.apple.lastuseddate#PS', received.extend)
assert received == metadata
for operation in ['write', 'delete', 'delete_on_read_handle']:
    try:
        if operation == 'write':
            reader.putFile('Files', 'renamed.txt:com.apple.lastuseddate#PS', io.BytesIO(b'no').read)
        elif operation == 'delete':
            reader.deleteFile('Files', 'renamed.txt:com.apple.lastuseddate#PS')
        else:
            file_id = reader.openFile(reader_tree, 'renamed.txt:com.apple.lastuseddate#PS', desiredAccess=FILE_READ_DATA, creationDisposition=FILE_OPEN)
            reader.getSMBServer().setInfo(reader_tree, file_id, inputBlob=b'\x01', fileInfoClass=13)
        raise AssertionError('Read-only stream mutation succeeded: ' + operation)
    except (SessionError, SMB3SessionError) as error:
        status = error.getErrorCode() if isinstance(error, SessionError) else error.get_error_code()
        assert status == 0xC0000022, error
reader.close()

if phase == 'reopen':
    for base in ['renamed.txt', 'folder', '']:
        client.deleteFile('Files', base + ':com.apple.lastuseddate#PS')
    received = bytearray()
    client.getFile('Files', 'renamed.txt', received.extend)
    assert received == b'original'
client.close()
print('SMB streams: capabilities, transfer, enumeration, persistence, confinement, and read-only access passed (' + phase + ').')
