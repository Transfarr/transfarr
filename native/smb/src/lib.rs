use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::Deserialize;
use smb_server::{Access, ConfigHandle, LocalFsBackend, Share, ShutdownHandle, SmbServer};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Deserialize)]
struct User {
    username: String,
    password: String,
}
#[derive(Deserialize)]
struct Grant {
    username: String,
    write: bool,
}
#[derive(Deserialize)]
struct Folder {
    name: String,
    path: String,
    grants: Vec<Grant>,
    anonymous: Option<String>,
}
#[derive(Deserialize)]
struct Config {
    listen: String,
    users: Vec<User>,
    folders: Vec<Folder>,
}

// A native library loaded by Node, never a child process or system daemon.
#[napi]
pub struct SmbBinding {
    audit: Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
    running: Arc<
        Mutex<
            Option<(
                ShutdownHandle,
                tokio::task::JoinHandle<std::io::Result<()>>,
                ConfigHandle,
            )>,
        >,
    >,
}

#[napi]
impl SmbBinding {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            audit: Arc::new(std::sync::Mutex::new(Vec::new())),
            running: Arc::new(Mutex::new(None)),
        }
    }

    #[napi]
    pub async fn configure(&self, json: String) -> Result<()> {
        let config: Config =
            serde_json::from_str(&json).map_err(|e| Error::from_reason(e.to_string()))?;
        let paths: Vec<_> = config.folders.iter().map(|folder| (folder.name.clone(), folder.path.clone())).collect();
        let mut builder = SmbServer::builder().listen(
            config
                .listen
                .parse()
                .map_err(|e: std::net::AddrParseError| Error::from_reason(e.to_string()))?,
        );
        for user in config.users {
            builder = builder.user(user.username, user.password);
        }
        for folder in config.folders {
            let backend =
                LocalFsBackend::new(&folder.path).map_err(|e| Error::from_reason(e.to_string()))?;
            let mut share = Share::new(folder.name, backend);
            if let Some(access) = folder.anonymous {
                share = share.anonymous(if access == "write" {
                    Access::ReadWrite
                } else {
                    Access::Read
                });
            }
            for grant in folder.grants {
                share = share.user(
                    grant.username,
                    if grant.write {
                        Access::ReadWrite
                    } else {
                        Access::Read
                    },
                );
            }
            builder = builder.share(share);
        }
        let server = builder
            .build()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let audit = self.audit.clone();
        *server.state().audit_sink.write().unwrap() = Some(Arc::new(move |event| {
            let mut entries = audit.lock().unwrap();
            let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
            // Bound the native queue if Node is temporarily busy; report any lost events.
            if entries.len() >= 10000 {
                let last = entries.last_mut().unwrap();
                if last["action"] == "Log overflow" {
                    let count = last["dropped"].as_u64().unwrap_or(0) + 1;
                    last["dropped"] = count.into();
                    last["details"] = format!("{count} SMB events could not be retained while the log consumer was busy").into();
                } else {
                    entries.push(serde_json::json!({ "timestamp": timestamp, "protocol": "smb", "user": "System", "action": "Log overflow", "outcome": "failure", "dropped": 1, "details": "1 SMB event could not be retained while the log consumer was busy" }));
                }
                return;
            }
            let mut parts = event.path.trim_start_matches('/').splitn(2, '/');
            let share = parts.next().unwrap_or("");
            let relative = parts.next().unwrap_or("");
            let host_path = paths.iter().find(|(name, _)| name == share)
                .map(|(_, root)| std::path::Path::new(root).join(relative).to_string_lossy().into_owned()).unwrap_or_default();
            let outcome = match event.status {
                smb_server::ntstatus::STATUS_SUCCESS => "success",
                smb_server::ntstatus::STATUS_MORE_PROCESSING_REQUIRED | smb_server::ntstatus::STATUS_PENDING |
                smb_server::ntstatus::STATUS_END_OF_FILE | smb_server::ntstatus::STATUS_NO_MORE_FILES => "info",
                _ => "failure",
            };
            entries.push(serde_json::json!({ "timestamp": timestamp, "protocol": "smb", "user": event.user,
                "action": event.action, "path": event.path, "destination": event.destination, "hostPath": host_path,
                "remoteAddress": event.remote_address, "outcome": outcome, "details": format!("SMB status 0x{:08X}", event.status) }));
        }));
        let mut running = self.running.lock().await;
        // Reconfiguration disconnects existing clients so revoked access cannot linger.
        if let Some((shutdown, task, _)) = running.take() {
            shutdown.shutdown();
            task.await
                .map_err(|e| Error::from_reason(e.to_string()))?
                .map_err(|e| Error::from_reason(e.to_string()))?;
        }
        server
            .bind()
            .await
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let shutdown = server.shutdown_handle();
        let config_handle = server.config_handle();
        *running = Some((shutdown, tokio::spawn(server.serve()), config_handle));
        Ok(())
    }

    #[napi]
    pub async fn connection_count(&self) -> u32 {
        let running = self.running.lock().await;
        match running.as_ref() {
            Some((_, _, config)) => config.connection_count().await as u32,
            None => 0,
        }
    }

    #[napi]
    pub fn drain_logs(&self) -> String {
        let entries = std::mem::take(&mut *self.audit.lock().unwrap());
        serde_json::to_string(&entries).unwrap_or_else(|_| "[]".into())
    }

    #[napi]
    pub async fn stop(&self) -> Result<()> {
        if let Some((shutdown, task, _)) = self.running.lock().await.take() {
            shutdown.shutdown();
            task.await
                .map_err(|e| Error::from_reason(e.to_string()))?
                .map_err(|e| Error::from_reason(e.to_string()))?;
        }
        Ok(())
    }
}
