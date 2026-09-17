//! Per-connection task layout.

pub mod reader;
pub mod state;
pub mod writer;

use std::io;
use std::sync::Arc;

use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tracing::{debug, info};

use crate::server::ServerState;
use state::Connection;

/// Runs the reader and writer tasks for a single accepted connection until
/// either side hangs up. Returns once both halves are done.
pub async fn connection_loop(stream: TcpStream, server: Arc<ServerState>) -> io::Result<()> {
    let remote_address = stream.peer_addr().map(|addr| addr.ip().to_string()).unwrap_or_default();
    let (read_half, write_half) = tokio::io::split(stream);
    let mut conn = Connection::new(
        server.config.server_guid,
        server.config.max_read_size,
        server.config.max_write_size,
    );
    conn.remote_address = remote_address;
    let conn = Arc::new(conn);
    let conn_id = server.active_connections.register(&conn).await;
    let (tx, rx) = mpsc::channel::<writer::FramePayload>(writer::WRITER_CHANNEL);

    let writer_handle = tokio::spawn(writer::writer_task(write_half, rx));

    info!("connection accepted");
    let reader_result = reader::reader_task(read_half, server.clone(), conn.clone(), tx).await;
    debug!(?reader_result, "reader exited");
    // Wait for writer to drain.
    let _ = writer_handle.await;
    let sink = server.audit_sink.read().unwrap().clone();
    if let Some(sink) = sink {
        let sessions = conn.sessions.read().await;
        for session in sessions.values() {
            let user = match &session.read().await.identity {
                crate::Identity::Anonymous => "anonymous".into(),
                crate::Identity::User { user, .. } => user.clone(),
            };
            sink(crate::audit::AuditEvent { user, action: "Disconnect".into(), path: String::new(),
                destination: String::new(), remote_address: conn.remote_address.clone(), status: 0 });
        }
    }
    server.active_connections.unregister(conn_id).await;
    info!("connection closed");
    reader_result
}
