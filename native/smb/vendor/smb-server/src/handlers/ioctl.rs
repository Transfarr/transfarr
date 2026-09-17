//! IOCTL handler — handles FSCTL_VALIDATE_NEGOTIATE_INFO; everything else
//! returns NOT_SUPPORTED.

use std::sync::Arc;

use crate::proto::header::Smb2Header;
use crate::proto::messages::{Fsctl, IoctlRequest, IoctlResponse};

use crate::conn::state::Connection;
use crate::dispatch::HandlerResponse;
use crate::handlers::negotiate::{NEGOTIATE_CAPABILITIES, NEGOTIATE_SECURITY_MODE};
use crate::ntstatus;
use crate::server::ServerState;

pub async fn handle(
    server: &Arc<ServerState>,
    conn: &Arc<Connection>,
    hdr: &Smb2Header,
    body: &[u8],
) -> HandlerResponse {
    let req = match IoctlRequest::parse(body) {
        Ok(r) => r,
        Err(_) => return HandlerResponse::err(ntstatus::STATUS_INVALID_PARAMETER),
    };

    match req.fsctl() {
        Fsctl::PipeTranscede => {
            let tree = match crate::handlers::shared::lookup_session_tree(conn, hdr).await {
                Ok(t) => t,
                Err(s) => return HandlerResponse::err(s),
            };
            let open = match crate::handlers::shared::lookup_open(&tree, req.file_id).await {
                Some(o) => o,
                None => return HandlerResponse::err(ntstatus::STATUS_FILE_CLOSED),
            };
            let mut open = open.write().await;
            let Some(pipe) = open.pipe.as_mut() else {
                return HandlerResponse::err(ntstatus::STATUS_NOT_SUPPORTED);
            };
            if req.flags != IoctlRequest::FLAG_IS_FSCTL || req.max_output_response == 0 {
                return HandlerResponse::err(ntstatus::STATUS_INVALID_PARAMETER);
            }
            // Honor the wire offset, including any padding before the input.
            let Some(start) = req.input_offset.checked_sub(64) else {
                return HandlerResponse::err(ntstatus::STATUS_INVALID_PARAMETER);
            };
            let Some(input) =
                body.get(start as usize..(start as usize).saturating_add(req.input_count as usize))
            else {
                return HandlerResponse::err(ntstatus::STATUS_INVALID_PARAMETER);
            };
            if start < 56 || pipe.pending() != 0 || pipe.write(input).is_err() {
                open.pipe = None;
                return HandlerResponse::err(ntstatus::STATUS_INVALID_PARAMETER);
            }
            let output = pipe.read(req.max_output_response as usize);
            let remaining = pipe.remaining();
            let resp = IoctlResponse {
                structure_size: 49,
                reserved: 0,
                ctl_code: req.ctl_code,
                file_id: req.file_id,
                input_offset: 0,
                input_count: 0,
                output_offset: 0x70,
                output_count: output.len() as u32,
                flags: 0,
                reserved2: 0,
                output,
            };
            let mut buf = Vec::new();
            resp.write_to(&mut buf).expect("encode pipe transceive");
            let mut result = HandlerResponse::ok(buf);
            if remaining > 0 {
                result.status = ntstatus::STATUS_BUFFER_OVERFLOW;
            }
            result
        }
        Fsctl::ValidateNegotiateInfo => {
            // Build VALIDATE_NEGOTIATE_INFO_RESPONSE per MS-SMB2 §2.2.32.6:
            // Capabilities (4) | Guid (16) | SecurityMode (2) | Dialect (2) = 24 bytes.
            let dialect = conn.dialect.read().await.map(|d| d.as_u16()).unwrap_or(0);
            let mut out = Vec::with_capacity(24);
            out.extend_from_slice(&NEGOTIATE_CAPABILITIES.to_le_bytes());
            out.extend_from_slice(server.config.server_guid.as_bytes());
            out.extend_from_slice(&NEGOTIATE_SECURITY_MODE.to_le_bytes());
            out.extend_from_slice(&dialect.to_le_bytes());

            let resp = IoctlResponse {
                structure_size: 49,
                reserved: 0,
                ctl_code: req.ctl_code,
                file_id: req.file_id,
                input_offset: 0,
                input_count: 0,
                output_offset: 0x70,
                output_count: out.len() as u32,
                flags: 0,
                reserved2: 0,
                output: out,
            };
            let mut buf = Vec::new();
            resp.write_to(&mut buf).expect("IOCTL response encodes");
            HandlerResponse::ok(buf)
        }
        Fsctl::DfsGetReferrals | Fsctl::DfsGetReferralsEx => {
            HandlerResponse::err(ntstatus::STATUS_FS_DRIVER_REQUIRED)
        }
        _ => HandlerResponse::err(ntstatus::STATUS_NOT_SUPPORTED),
    }
}
