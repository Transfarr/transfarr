//! CREATE handler — open or create a file/directory and allocate a FileId.

use std::sync::Arc;

use crate::proto::header::Smb2Header;
use crate::proto::messages::{CreateRequest, CreateResponse};
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
            | FILE_WRITE_ATTRIBUTES
            | DELETE
            | GENERIC_WRITE
            | GENERIC_ALL
            | MAX_ALLOWED)
        != 0;

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
        create_contexts_offset: 0,
        create_contexts_length: 0,
        create_contexts: vec![],
    };
    let mut buf = Vec::new();
    resp.write_to(&mut buf).expect("encode");
    HandlerResponse::ok(buf)
}
