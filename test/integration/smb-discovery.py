"""Real signed SMB2/3 + DCE/RPC clients, kept out of the runtime image."""
import sys
from impacket.smbconnection import SMBConnection, SessionError
from impacket.dcerpc.v5 import transport, srvs
from impacket.dcerpc.v5.rpcrt import DCERPCException
from impacket.smb3structs import SMB2Ioctl_Response

port = int(sys.argv[1])
for username, expected in [('reader', ['Café', 'Shared']), ('other', ['Private']), ('empty', [])]:
    client = SMBConnection('127.0.0.1', '127.0.0.1', sess_port=port)
    client.login(username, 'test-password')
    assert sorted(s['shi1_netname'].rstrip('\0') for s in client.listShares()) == expected
    client.close()

client = SMBConnection('127.0.0.1', '127.0.0.1', sess_port=port)
try:
    client.login('reader', 'wrong-password')
    raise AssertionError('Invalid password accepted')
except SessionError:
    pass
finally:
    client.close()

client = SMBConnection('127.0.0.1', '127.0.0.1', sess_port=port)
client.login('reader', 'test-password')
try:
    client.connectTree('Private')
    raise AssertionError('Hidden share accessible directly')
except SessionError as error:
    assert error.getErrorCode() == 0xc0000022
client.close()

# Large lists exercise RPC response fragmentation through SMB WRITE + READ.
client = SMBConnection('127.0.0.1', '127.0.0.1', sess_port=port)
client.login('many', 'test-password')
expected = [f'Share-{i:04}' for i in range(250)]
assert [s['shi1_netname'].rstrip('\0') for s in client.listShares()] == expected
rpc = transport.SMBTransport('127.0.0.1', dstport=port, filename=r'\srvsvc', smb_connection=client).get_dce_rpc()
rpc.connect()
rpc.bind(srvs.MSRPC_UUID_SRVS)
for level in [0, 1]:
    names = []
    resume = 0
    while True:
        try:
            response = srvs.hNetrShareEnum(rpc, level, resumeHandle=resume, preferedMaximumLength=512)
        except srvs.DCERPCSessionError as error:
            assert error.get_error_code() == 234, error
            response = error.get_packet()
        assert response['TotalEntries'] == 250
        names += [s[f'shi{level}_netname'].rstrip('\0') for s in response['InfoStruct']['ShareInfo'][f'Level{level}']['Buffer']]
        if response['ErrorCode'] == 0:
            break
        assert response['ResumeHandle'] > resume
        resume = response['ResumeHandle']
    assert names == expected
try:
    srvs.hNetrShareEnum(rpc, 2)
    raise AssertionError('Unsupported information level accepted')
except srvs.DCERPCSessionError as error:
    assert error.get_error_code() == 124
rpc.disconnect()
client.close()

# Apple uses FSCTL_PIPE_TRANSCEIVE; test that separately from Impacket's default
# WRITE/READ transport, including partial IOCTL output followed by SMB READ.
client = SMBConnection('127.0.0.1', '127.0.0.1', sess_port=port)
client.login('reader', 'test-password')
tree = client.connectTree('IPC$')
pipe = client.openFile(tree, 'srvsvc', desiredAccess=3)
bind = bytes.fromhex('05000b03100000004800000001000000b810b810000000000100000000000100c84f324b7016d30112785a47bf6ee18803000000045d888aeb1cc9119fe808002b10486002000000')
ack = client.transactNamedPipe(tree, pipe, bind)
assert ack[2] == 12
request = bytes.fromhex('050000031000000060000000010000004800000000000f00de6c00000c000000000000000c0000005c005c003100320037002e0030002e0030002e00310000000100000001000000cfc000000000000000000000ffffffffd4b0000000000000')
try:
    client.getSMBServer().ioctl(tree, pipe, ctlCode=0x11c017, flags=1, inputBlob=request, maxInputResponse=0, maxOutputResponse=32)
    raise AssertionError('Expected an overflow response')
except Exception as error:
    assert error.get_error_code() == 0x80000005, error
    response = SMB2Ioctl_Response(error.get_error_packet()['Data'])['Buffer']
response += client.readFile(tree, pipe, bytesToRead=65536)
assert response[2] == 2
parsed = srvs.NetrShareEnumResponse(response[24:])
assert [s['shi1_netname'].rstrip('\0') for s in parsed['InfoStruct']['ShareInfo']['Level1']['Buffer']] == ['Café','Shared']
# Unsupported RPC operations produce a fault without leaking the share list.
unsupported = bytearray(request)
unsupported[22:24] = (999).to_bytes(2, 'little')
assert client.transactNamedPipe(tree, pipe, bytes(unsupported))[2] == 3
# Bad NDR gets a fault; invalid RPC framing closes only this pipe.
malformed = bytearray(request)
malformed[28:32] = (0xffffffff).to_bytes(4,'little')
assert client.transactNamedPipe(tree, pipe, bytes(malformed))[2] == 3
try:
    client.transactNamedPipe(tree, pipe, bytes(16))
    raise AssertionError('Malformed framing accepted')
except SessionError as error:
    assert error.getErrorCode() == 0xc000000d
client.close()
print('SMB discovery: ACLs, Unicode, empty lists, invalid credentials, pagination, fragmentation, IOCTL, and malformed requests passed.')
