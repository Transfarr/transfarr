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
            running: Arc::new(Mutex::new(None)),
        }
    }

    #[napi]
    pub async fn configure(&self, json: String) -> Result<()> {
        let config: Config =
            serde_json::from_str(&json).map_err(|e| Error::from_reason(e.to_string()))?;
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
