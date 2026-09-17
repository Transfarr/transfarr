//! Metadata-only activity events; payloads and authentication tokens never enter the log.
use std::sync::Arc;
use crate::conn::state::Connection;
use crate::handlers::shared::{lookup_session, lookup_session_tree, lookup_open};
use crate::proto::auth::ntlm::Identity;
use crate::proto::header::{Command, Smb2Header};
use crate::proto::messages::*;

pub struct AuditEvent {
    pub user: String,
    pub action: String,
    pub path: String,
    pub destination: String,
    pub remote_address: String,
    pub status: u32,
}

pub type AuditSink = Arc<dyn Fn(AuditEvent) + Send + Sync>;

impl AuditEvent {
    pub(crate) async fn capture(conn: &Arc<Connection>, hdr: &Smb2Header, body: &[u8]) -> Self {
        let mut event = Self { user: "Unauthenticated".into(), action: format!("{:?}", hdr.command),
            path: String::new(), destination: String::new(), remote_address: conn.remote_address.clone(), status: 0 };
        if let Ok(session) = lookup_session(conn, hdr.session_id).await {
            event.user = match &session.read().await.identity {
                Identity::Anonymous => "anonymous".into(),
                Identity::User { user, .. } => user.clone(),
            };
        }
        if matches!(hdr.command, Command::SessionSetup) {
            event.action = "Login".into();
            if let Ok(req) = SessionSetupRequest::parse(body) {
                let token = if req.security_buffer.starts_with(b"NTLMSSP\0") {
                    Some(req.security_buffer)
                } else {
                    crate::proto::auth::spnego::decode_resp_token(&req.security_buffer).ok().and_then(|r| r.response_token)
                };
                if let Some(token) = token {
                    if let Ok(auth) = crate::proto::auth::ntlm::NtlmAuthenticate::parse(&token) {
                        event.user = if auth.user.is_empty() { "anonymous".into() } else { auth.user };
                    }
                }
            }
        }
        let file_id = match hdr.command {
            Command::Read => ReadRequest::parse(body).ok().map(|r| r.file_id),
            Command::Write => WriteRequest::parse(body).ok().map(|r| r.file_id),
            Command::Close => CloseRequest::parse(body).ok().map(|r| r.file_id),
            Command::Flush => FlushRequest::parse(body).ok().map(|r| FileId::new(r.file_id_persistent, r.file_id_volatile)),
            Command::QueryDirectory => QueryDirectoryRequest::parse(body).ok().map(|r| r.file_id),
            Command::QueryInfo => QueryInfoRequest::parse(body).ok().map(|r| r.file_id),
            Command::SetInfo => SetInfoRequest::parse(body).ok().map(|r| r.file_id),
            Command::ChangeNotify => ChangeNotifyRequest::parse(body).ok().map(|r| r.file_id),
            Command::Lock => LockRequest::parse(body).ok().map(|r| r.file_id),
            Command::Ioctl => IoctlRequest::parse(body).ok().map(|r| r.file_id),
            _ => None,
        };
        if let Ok(tree) = lookup_session_tree(conn, hdr).await {
            let share = tree.read().await.share.name.clone();
            event.path = format!("/{share}");
            if let Some(file_id) = file_id {
                if let Some(open) = lookup_open(&tree, file_id).await {
                    let open = open.read().await;
                    event.path = format!("/{share}/{}", open.last_path.components().join("/"));
                    if matches!(hdr.command, Command::Close) && open.delete_on_close {
                        event.action = "Delete on close".into();
                    }
                }
            }
            if matches!(hdr.command, Command::Create) {
                if let Some(name) = CreateRequest::parse(body).ok().and_then(|r| r.name_str()) {
                    event.path = format!("/{share}/{}", name.replace('\\', "/"));
                    event.action = "Open / create".into();
                }
            }
            if matches!(hdr.command, Command::SetInfo) {
                if let Ok(req) = SetInfoRequest::parse(body) {
                    match req.file_information_class {
                        crate::info_class::FILE_RENAME_INFORMATION => {
                            event.action = "Rename".into();
                            if req.buffer.len() >= 20 {
                                let len = u32::from_le_bytes(req.buffer[16..20].try_into().unwrap()) as usize;
                                if let Some(bytes) = req.buffer.get(20..20usize.saturating_add(len)) {
                                    let units: Vec<u16> = bytes.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
                                    event.destination = format!("/{share}/{}", String::from_utf16_lossy(&units).replace('\\', "/"));
                                }
                            }
                        }
                        crate::info_class::FILE_DISPOSITION_INFORMATION => event.action = "Set deletion flag".into(),
                        crate::info_class::FILE_END_OF_FILE_INFORMATION => event.action = "Truncate".into(),
                        crate::info_class::FILE_BASIC_INFORMATION => event.action = "Set timestamps".into(),
                        _ => {},
                    }
                }
            }
        }
        if matches!(hdr.command, Command::TreeConnect) {
            if let Some(name) = TreeConnectRequest::parse(body).ok().and_then(|r| r.path_str()) {
                event.path = format!("/{}", name.rsplit('\\').next().unwrap_or(&name));
            }
        }
        event
    }
}
