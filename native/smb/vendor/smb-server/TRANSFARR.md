Based on paltaio/rust-smb-server revision 4ce1981a2cdf4bf1e26a5b806376e9f6323e5234 (MIT).

Transfarr adds authenticated IPC$/srvsvc share enumeration using NDR32 over DCE/RPC.
CREATE requests honor name/context offsets and return MxAc permission queries for Apple clients. MAXIMUM_ALLOWED opens respect read-only grants.
Local filesystems with xattr support advertise named streams and persist small $DATA streams as user.DosStream attributes. Streams are capability-confined, enumerated through QUERY_INFO, and follow base-file renames and deletion. Individual stream renames are unsupported; stream sizes are limited to 65,535 bytes and the host filesystem's xattr limits.
The vendored source keeps native and Docker builds reproducible. The example workspace and external integration-test targets are omitted.
