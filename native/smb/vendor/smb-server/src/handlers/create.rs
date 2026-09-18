//! CREATE handler — open or create a file/directory and allocate a FileId.

use std::sync::Arc;

use crate::proto::header::Smb2Header;
use crate::proto::messages::{CreateContext, CreateRequest, CreateResponse};
use tracing::{debug, warn};

use crate::backend::{OpenIntent, OpenOptions};
use crate::builder::Access;
use crate::conn::state::{Connection, Open};
use crate::dispatch::HandlerResponse;
use crate::handlers::shared::lookup_session_tree;
use crate::ntstatus;
use crate::path::SmbPath;
use crate::server::ServerState;
use crate::utils::utf16le_to_units;

// MS-SMB2 §2.2.13 access mask flags
const FILE_READ_DATA: u32 = 0x0000_0001;
const FILE_WRITE_DATA: u32 = 0x0000_0002;
const FILE_APPEND_DATA: u32 = 0x0000_0004;
const FILE_WRITE_EA: u32 = 0x0000_0010;
const FILE_READ_ATTRIBUTES: u32 = 0x0000_0080;
const FILE_WRITE_ATTRIBUTES: u32 = 0x0000_0100;
const DELETE: u32 = 0x0001_0000;
const GENERIC_READ: u32 = 0x8000_0000;
const GENERIC_WRITE: u32 = 0x4000_0000;
const GENERIC_ALL: u32 = 0x1000_0000;
const MAX_ALLOWED: u32 = 0x0200_0000;

// CreateOptions
const FILE_DIRECTORY_FILE: u32 = 0x0000_0001;
const FILE_NON_DIRECTORY_FILE: u32 = 0x0000_0040;
const FILE_DELETE_ON_CLOSE: u32 = 0x0000_1000;

// CreateDisposition
const FILE_SUPERSEDE: u32 = 0x0000_0000;
const FILE_OPEN: u32 = 0x0000_0001;
const FILE_CREATE: u32 = 0x0000_0002;
const FILE_OPEN_IF: u32 = 0x0000_0003;
const FILE_OVERWRITE: u32 = 0x0000_0004;
const FILE_OVERWRITE_IF: u32 = 0x0000_0005;

// CreateAction in response (MS-SMB2 §2.2.14)
const FILE_OPENED: u32 = 0x0000_0001;
const FILE_CREATED: u32 = 0x0000_0002;

pub async fn handle(
    server: &Arc<ServerState>,
    conn: &Arc<Connection>,
    hdr: &Smb2Header,
    body: &[u8],
) -> HandlerResponse {
    let req = match CreateRequest::parse(body) {
        Ok(r) => r,
        Err(_) => return HandlerResponse::err(ntstatus::STATUS_INVALID_PARAMETER),
    };
    let contexts = match CreateContext::parse_chain(&req.create_contexts) {
        Ok(contexts) => contexts,
        Err(_) => return HandlerResponse::err(ntstatus::STATUS_INVALID_PARAMETER),
    };
    let maximal_access_request = contexts
        .iter()
        .find(|ctx| ctx.name == CreateContext::NAME_MXAC);
    if maximal_access_request.is_some_and(|ctx| !matches!(ctx.data.len(), 0 | 8)) {
        return HandlerResponse::err(ntstatus::STATUS_INVALID_PARAMETER);
    }

    let tree_arc = match lookup_session_tree(conn, hdr).await {
        Ok(t) => t,
        Err(s) => return HandlerResponse::err(s),
    };
    let tree = tree_arc.read().await;
    let is_ipc = tree.share.is_ipc;
    let granted = tree.granted_access;
    let backend = tree.share.backend.clone();
    drop(tree);

    // Decode path.
    let units = match utf16le_to_units(&req.name) {
        Some(u) => u,
        None => return HandlerResponse::err(ntstatus::STATUS_OBJECT_NAME_INVALID),
    };
    let path = match SmbPath::from_utf16(&units) {
        Ok(p) => p,
        Err(_) => return HandlerResponse::err(ntstatus::STATUS_OBJECT_NAME_INVALID),
    };

    if is_ipc {
        if !String::from_utf16_lossy(&units)
            .trim_matches('\\')
            .eq_ignore_ascii_case("srvsvc")
        {
            return HandlerResponse::err(ntstatus::STATUS_OBJECT_NAME_NOT_FOUND);
        }
        let sess = match crate::handlers::shared::lookup_session(conn, hdr.session_id).await {
            Ok(s) => s,
            Err(s) => return HandlerResponse::err(s),
        };
        let identity = sess.read().await.identity.clone();
        let mut names = Vec::new();
        for share in server.shares.all().await {
            let acl = share.acl.read().await;
            if !share.is_ipc
                && super::tree_connect::authorize(&acl.mode, &acl.users, &identity).is_some()
            {
                names.push(share.name.clone());
            }
        }
        let tree = tree_arc.write().await;
        let file_id = tree.alloc_file_id();
        let open = Open {
            file_id,
            handle: None,
            pipe: Some(crate::srvsvc::Pipe::new(names)),
            granted_access: Access::ReadWrite,
            last_path: path,
            is_directory: false,
            delete_on_close: false,
            search_state: None,
        };
        tree.opens
            .write()
            .await
            .insert(file_id, Arc::new(tokio::sync::RwLock::new(open)));
        let resp = CreateResponse {
            structure_size: 89,
            oplock_level: 0,
            flags: 0,
            create_action: FILE_OPENED,
            creation_time: 0,
            last_access_time: 0,
            last_write_time: 0,
            change_time: 0,
            allocation_size: 0,
            end_of_file: 0,
            file_attributes: 0x80,
            reserved2: 0,
            file_id,
            create_contexts_offset: 0,
            create_contexts_length: 0,
            create_contexts: vec![],
        };
        let mut buf = Vec::new();
        resp.write_to(&mut buf).expect("encode pipe open");
        return HandlerResponse::ok(buf);
    }

    // Translate disposition.
    let intent = match req.create_disposition {
        FILE_SUPERSEDE | FILE_OVERWRITE_IF => OpenIntent::OverwriteOrCreate,
        FILE_OPEN => OpenIntent::Open,
        FILE_CREATE => OpenIntent::Create,
        FILE_OPEN_IF => OpenIntent::OpenOrCreate,
        FILE_OVERWRITE => OpenIntent::Truncate,
        _ => return HandlerResponse::err(ntstatus::STATUS_INVALID_PARAMETER),
    };

    // Translate desired access into read/write hints.
    let want_read = req.desired_access
        & (FILE_READ_DATA | FILE_READ_ATTRIBUTES | GENERIC_READ | GENERIC_ALL | MAX_ALLOWED)
        != 0;
    let want_write = req.desired_access
        & (FILE_WRITE_DATA
            | FILE_APPEND_DATA
            | FILE_WRITE_EA
            | FILE_WRITE_ATTRIBUTES
            | DELETE
            | GENERIC_WRITE
            | GENERIC_ALL)
        != 0
        || (req.desired_access & MAX_ALLOWED != 0 && granted.allows_write());

    // Reject writes on a read-only tree.
    if want_write && !granted.allows_write() {
        warn!(path = %path, "write open on read-only tree");
        return HandlerResponse::err(ntstatus::STATUS_ACCESS_DENIED);
    }
    // Disposition that creates: requires write permission.
    if !granted.allows_write()
        && matches!(
            intent,
            OpenIntent::Create
                | OpenIntent::OpenOrCreate
                | OpenIntent::OverwriteOrCreate
                | OpenIntent::Truncate
        )
    {
        return HandlerResponse::err(ntstatus::STATUS_ACCESS_DENIED);
    }

    let directory = req.create_options & FILE_DIRECTORY_FILE != 0;
    let non_directory = req.create_options & FILE_NON_DIRECTORY_FILE != 0;
    if directory && non_directory {
        return HandlerResponse::err(ntstatus::STATUS_INVALID_PARAMETER);
    }
    let delete_on_close = req.create_options & FILE_DELETE_ON_CLOSE != 0;
    if delete_on_close && (!granted.allows_write() || !want_write) {
        return HandlerResponse::err(ntstatus::STATUS_ACCESS_DENIED);
    }

    let opts = OpenOptions {
        read: want_read || !want_write,
        write: want_write,
        intent,
        directory,
        non_directory,
        delete_on_close,
    };

    let handle = match backend.open(&path, opts).await {
        Ok(h) => h,
        Err(e) => {
            debug!(error = %e, path = %path, "backend open failed");
            return HandlerResponse::err(e.to_nt_status());
        }
    };

    // Stat for the response.
    let info = match handle.stat().await {
        Ok(i) => i,
        Err(e) => {
            let _ = handle.close().await;
            return HandlerResponse::err(e.to_nt_status());
        }
    };

    // Report the user's share permissions even when this particular handle
    // was opened only to read attributes. Apple clients use MxAc for access checks.
    let mut create_contexts = Vec::new();
    if let Some(ctx) = maximal_access_request {
        let unchanged = ctx.data.len() == 8
            && u64::from_le_bytes(ctx.data.as_slice().try_into().unwrap()) == info.change_time;
        let status: u32 = if unchanged {
            0xC000_0073
        } else {
            ntstatus::STATUS_SUCCESS
        }; // STATUS_NONE_MAPPED
        let access: u32 = if unchanged {
            0
        } else if granted.allows_write() {
            0x001F_01FF // FILE_ALL_ACCESS
        } else {
            0x0012_00A9 // FILE_GENERIC_READ | FILE_GENERIC_EXECUTE
        };
        let mut data = status.to_le_bytes().to_vec();
        data.extend_from_slice(&access.to_le_bytes());
        CreateContext::encode_chain(
            &[CreateContext {
                name: CreateContext::NAME_MXAC.to_vec(),
                data,
            }],
            &mut create_contexts,
        )
        .expect("encode maximal access context");
    }

    // Allocate FileId, register Open.
    let tree = tree_arc.write().await;
    let file_id = tree.alloc_file_id();
    let open = Open::new(
        file_id,
        handle,
        if want_write { granted } else { Access::Read },
        path,
        info.is_directory,
        delete_on_close,
    );
    let open_arc = Arc::new(tokio::sync::RwLock::new(open));
    tree.opens.write().await.insert(file_id, open_arc);
    drop(tree);

    let create_action = match intent {
        OpenIntent::Create => FILE_CREATED,
        OpenIntent::OpenOrCreate | OpenIntent::OverwriteOrCreate => FILE_OPENED,
        OpenIntent::Open | OpenIntent::Truncate => FILE_OPENED,
    };
    let resp = CreateResponse {
        structure_size: 89,
        oplock_level: 0,
        flags: 0,
        create_action,
        creation_time: info.creation_time,
        last_access_time: info.last_access_time,
        last_write_time: info.last_write_time,
        change_time: info.change_time,
        allocation_size: info.allocation_size,
        end_of_file: info.end_of_file,
        file_attributes: info.attributes(),
        reserved2: 0,
        file_id,
        create_contexts_offset: if create_contexts.is_empty() {
            0
        } else {
            64 + 88
        },
        create_contexts_length: create_contexts.len() as u32,
        create_contexts,
    };
    let mut buf = Vec::new();
    resp.write_to(&mut buf).expect("encode");
    HandlerResponse::ok(buf)
}

#[cfg(all(test, feature = "localfs"))]
mod tests {
    use super::*;
    use crate::conn::state::Session;
    use crate::proto::header::HeaderTail;
    use crate::proto::messages::TreeConnectRequest;
    use crate::{Identity, LocalFsBackend, Share, SmbServer};
    use tokio::sync::RwLock;

    #[tokio::test]
    async fn maximal_access_with_padded_contexts_respects_share_and_backend_permissions() {
        for (access, backend_read_only) in [
            (Access::ReadWrite, false),
            (Access::Read, false),
            (Access::ReadWrite, true),
        ] {
            let directory = tempfile::tempdir().unwrap();
            std::fs::write(directory.path().join("x"), b"original").unwrap();
            let mut backend = LocalFsBackend::new(directory.path()).unwrap();
            if backend_read_only {
                backend = backend.read_only();
            }
            let server = SmbServer::builder()
                .listen("127.0.0.1:0".parse().unwrap())
                .user("alice", "password")
                .share(Share::new("home", backend).user("alice", access))
                .build()
                .unwrap();
            let state = server.state();
            let conn = Arc::new(Connection::new(state.config.server_guid, 65536, 65536));
            conn.sessions.write().await.insert(
                1,
                Arc::new(RwLock::new(Session::new(
                    1,
                    Identity::User {
                        user: "alice".into(),
                        domain: String::new(),
                    },
                    [0; 16],
                    [0; 16],
                    false,
                    None,
                ))),
            );
            let mut hdr = Smb2Header {
                session_id: 1,
                ..Default::default()
            };
            let path: Vec<u8> = "\\\\server\\home"
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect();
            let mut body = Vec::new();
            TreeConnectRequest {
                structure_size: 9,
                flags: 0,
                path_offset: 72,
                path_length: path.len() as u16,
                path,
            }
            .write_to(&mut body)
            .unwrap();
            let response = super::super::tree_connect::handle(&state, &conn, &hdr, &body).await;
            assert_eq!(response.status, ntstatus::STATUS_SUCCESS);
            hdr.tail = HeaderTail::sync(response.override_tree_id.unwrap());
            let writable = access.allows_write() && !backend_read_only;
            let expected_access: u32 = if writable { 0x001F_01FF } else { 0x0012_00A9 };

            for (name, options) in [("", FILE_DIRECTORY_FILE), ("x", FILE_NON_DIRECTORY_FILE)] {
                // A metadata-only open must still return the user's full access.
                for desired_access in [FILE_READ_ATTRIBUTES, MAX_ALLOWED, FILE_WRITE_DATA] {
                    let name: Vec<u8> = name.encode_utf16().flat_map(u16::to_le_bytes).collect();
                    let context_offset = (56 + name.len() + 8) & !7;
                    let mut body = vec![0u8; context_offset];
                    body[0..2].copy_from_slice(&57u16.to_le_bytes());
                    body[24..28].copy_from_slice(&desired_access.to_le_bytes());
                    body[32..36].copy_from_slice(&7u32.to_le_bytes());
                    body[36..40].copy_from_slice(&FILE_OPEN.to_le_bytes());
                    body[40..44].copy_from_slice(&options.to_le_bytes());
                    body[44..46].copy_from_slice(&120u16.to_le_bytes());
                    body[46..48].copy_from_slice(&(name.len() as u16).to_le_bytes());
                    body[48..52].copy_from_slice(&((context_offset + 64) as u32).to_le_bytes());
                    body[56..56 + name.len()].copy_from_slice(&name);
                    let mut contexts = Vec::new();
                    CreateContext::encode_chain(
                        &[
                            CreateContext {
                                name: b"QFid".to_vec(),
                                data: vec![],
                            },
                            CreateContext {
                                name: b"MxAc".to_vec(),
                                data: vec![],
                            },
                        ],
                        &mut contexts,
                    )
                    .unwrap();
                    body[52..56].copy_from_slice(&(contexts.len() as u32).to_le_bytes());
                    body.extend_from_slice(&contexts);
                    let response = handle(&state, &conn, &hdr, &body).await;
                    if desired_access == FILE_WRITE_DATA && !writable {
                        assert_eq!(response.status, ntstatus::STATUS_ACCESS_DENIED);
                        continue;
                    }
                    assert_eq!(response.status, ntstatus::STATUS_SUCCESS);
                    let response = CreateResponse::parse(&response.body).unwrap();
                    assert_eq!(response.create_contexts_offset, 152);
                    assert_eq!(response.create_contexts_length, 32);
                    let contexts = CreateContext::parse_chain(&response.create_contexts).unwrap();
                    assert_eq!(contexts.len(), 1);
                    assert_eq!(contexts[0].name, b"MxAc");
                    assert_eq!(
                        &contexts[0].data[..4],
                        &ntstatus::STATUS_SUCCESS.to_le_bytes()
                    );
                    assert_eq!(&contexts[0].data[4..], &expected_access.to_le_bytes());

                    // A timestamp matching ChangeTime must return NONE_MAPPED.
                    let mut contexts = Vec::new();
                    CreateContext::encode_chain(
                        &[CreateContext {
                            name: b"MxAc".to_vec(),
                            data: response.change_time.to_le_bytes().to_vec(),
                        }],
                        &mut contexts,
                    )
                    .unwrap();
                    body.truncate(context_offset);
                    body[52..56].copy_from_slice(&(contexts.len() as u32).to_le_bytes());
                    body.extend_from_slice(&contexts);
                    let response = handle(&state, &conn, &hdr, &body).await;
                    assert_eq!(response.status, ntstatus::STATUS_SUCCESS);
                    let response = CreateResponse::parse(&response.body).unwrap();
                    let contexts = CreateContext::parse_chain(&response.create_contexts).unwrap();
                    assert_eq!(contexts[0].data, [0x73, 0, 0, 0xC0, 0, 0, 0, 0]);

                    // No context requested: preserve the context-free response.
                    body.truncate(56 + name.len());
                    body[48..56].fill(0);
                    let response = handle(&state, &conn, &hdr, &body).await;
                    assert_eq!(response.status, ntstatus::STATUS_SUCCESS);
                    let response = CreateResponse::parse(&response.body).unwrap();
                    assert_eq!(response.create_contexts_offset, 0);
                    assert_eq!(response.create_contexts_length, 0);
                }
            }
            conn.close_session(1).await;
            assert_eq!(
                std::fs::read(directory.path().join("x")).unwrap(),
                b"original"
            );
        }
    }

    #[tokio::test]
    async fn malformed_create_contexts_are_rejected_before_opening_files() {
        let server = SmbServer::builder()
            .listen("127.0.0.1:0".parse().unwrap())
            .build()
            .unwrap();
        let state = server.state();
        let conn = Arc::new(Connection::new(state.config.server_guid, 65536, 65536));
        for data in [vec![0], vec![0; 7], vec![0; 9]] {
            let mut body = vec![0u8; 56];
            body[0..2].copy_from_slice(&57u16.to_le_bytes());
            body[48..52].copy_from_slice(&120u32.to_le_bytes());
            let mut contexts = Vec::new();
            CreateContext::encode_chain(
                &[CreateContext {
                    name: b"MxAc".to_vec(),
                    data,
                }],
                &mut contexts,
            )
            .unwrap();
            body[52..56].copy_from_slice(&(contexts.len() as u32).to_le_bytes());
            body.extend_from_slice(&contexts);
            let response = handle(&state, &conn, &Smb2Header::default(), &body).await;
            assert_eq!(response.status, ntstatus::STATUS_INVALID_PARAMETER);
            body.truncate(body.len() - 1);
            assert!(CreateRequest::parse(&body).is_err());
            body[48..52].copy_from_slice(&64u32.to_le_bytes());
            assert!(CreateRequest::parse(&body).is_err());
        }
    }
}
