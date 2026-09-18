//! Small named $DATA streams persisted as xattrs on capability-opened base files.
//! The trailing NUL matches Samba's streams_xattr representation. The host
//! filesystem may impose a lower limit than the 64 KiB allocation bound here.

use std::ffi::OsString;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use bytes::Bytes;
use tokio::task::spawn_blocking;
use xattr::FileExt as _;

use super::local::{file_info_from_metadata, io_to_smb};
use crate::backend::{DirEntry, FileInfo, FileTimes, Handle};
use crate::error::{SmbError, SmbResult};

// Serialize xattr read/modify/write across handles and shares in this process.
pub(super) static STREAM_LOCK: Mutex<()> = Mutex::new(());
const MAX_STREAM_SIZE: u64 = 65535;

pub(super) struct StreamHandle {
    pub base: Arc<std::fs::File>,
    pub attribute: OsString,
    pub name: String,
    pub writable: bool,
}

#[async_trait]
impl Handle for StreamHandle {
    async fn read(&self, offset: u64, len: u32) -> SmbResult<Bytes> {
        let base = Arc::clone(&self.base);
        let attribute = self.attribute.clone();
        spawn_blocking(move || {
            let data = base
                .get_xattr(attribute)
                .map_err(io_to_smb)?
                .ok_or(SmbError::NotFound)?;
            if data.last() != Some(&0) {
                return Err(SmbError::NotSupported);
            }
            let size = data.len() - 1;
            if offset >= size as u64 {
                return Ok(Bytes::new());
            }
            let start = offset as usize;
            let end = start.saturating_add(len as usize).min(size);
            Ok(Bytes::copy_from_slice(&data[start..end]))
        })
        .await
        .map_err(|e| SmbError::Io(std::io::Error::other(e)))?
    }

    async fn write(&self, offset: u64, data: &[u8]) -> SmbResult<u32> {
        self.write_owned(offset, data.to_vec()).await
    }

    async fn write_owned(&self, offset: u64, data: Vec<u8>) -> SmbResult<u32> {
        if !self.writable {
            return Err(SmbError::AccessDenied);
        }
        if offset > MAX_STREAM_SIZE || data.len() as u64 > MAX_STREAM_SIZE - offset {
            return Err(SmbError::NotSupported);
        }
        let base = Arc::clone(&self.base);
        let attribute = self.attribute.clone();
        spawn_blocking(move || {
            let _guard = STREAM_LOCK.lock().unwrap();
            let mut current = base
                .get_xattr(&attribute)
                .map_err(io_to_smb)?
                .ok_or(SmbError::NotFound)?;
            if current.pop() != Some(0) {
                return Err(SmbError::NotSupported);
            }
            if data.is_empty() {
                return Ok(0);
            }
            let start = offset as usize;
            current.resize(current.len().max(start + data.len()), 0);
            current[start..start + data.len()].copy_from_slice(&data);
            current.push(0);
            base.set_xattr(attribute, &current).map_err(io_to_smb)?;
            Ok(data.len() as u32)
        })
        .await
        .map_err(|e| SmbError::Io(std::io::Error::other(e)))?
    }

    async fn flush(&self) -> SmbResult<()> {
        let base = Arc::clone(&self.base);
        spawn_blocking(move || base.sync_all().map_err(io_to_smb))
            .await
            .map_err(|e| SmbError::Io(std::io::Error::other(e)))?
    }

    async fn stat(&self) -> SmbResult<FileInfo> {
        let base = Arc::clone(&self.base);
        let attribute = self.attribute.clone();
        let name = self.name.clone();
        spawn_blocking(move || {
            let data = base
                .get_xattr(attribute)
                .map_err(io_to_smb)?
                .ok_or(SmbError::NotFound)?;
            if data.last() != Some(&0) {
                return Err(SmbError::NotSupported);
            }
            let md = cap_std::fs::Metadata::from_just_metadata(base.metadata().map_err(io_to_smb)?);
            let mut info = file_info_from_metadata(name, &md);
            info.is_directory = false;
            info.end_of_file = (data.len() - 1) as u64;
            info.allocation_size = info.end_of_file;
            Ok(info)
        })
        .await
        .map_err(|e| SmbError::Io(std::io::Error::other(e)))?
    }

    async fn set_times(&self, times: FileTimes) -> SmbResult<()> {
        if !self.writable {
            return Err(SmbError::AccessDenied);
        }
        let base = Arc::clone(&self.base);
        spawn_blocking(move || {
            let mut value = std::fs::FileTimes::new();
            if let Some(time) = times
                .last_write_time
                .and_then(super::local::filetime_to_system_time)
            {
                value = value.set_modified(time);
            }
            if let Some(time) = times
                .last_access_time
                .and_then(super::local::filetime_to_system_time)
            {
                value = value.set_accessed(time);
            }
            base.set_times(value).map_err(io_to_smb)
        })
        .await
        .map_err(|e| SmbError::Io(std::io::Error::other(e)))?
    }

    async fn truncate(&self, len: u64) -> SmbResult<()> {
        if !self.writable {
            return Err(SmbError::AccessDenied);
        }
        if len > MAX_STREAM_SIZE {
            return Err(SmbError::NotSupported);
        }
        let base = Arc::clone(&self.base);
        let attribute = self.attribute.clone();
        spawn_blocking(move || {
            let _guard = STREAM_LOCK.lock().unwrap();
            let mut current = base
                .get_xattr(&attribute)
                .map_err(io_to_smb)?
                .ok_or(SmbError::NotFound)?;
            if current.pop() != Some(0) {
                return Err(SmbError::NotSupported);
            }
            current.resize(len as usize, 0);
            current.push(0);
            base.set_xattr(attribute, &current).map_err(io_to_smb)
        })
        .await
        .map_err(|e| SmbError::Io(std::io::Error::other(e)))?
    }

    async fn list_dir(&self, _pattern: Option<&str>) -> SmbResult<Vec<DirEntry>> {
        Err(SmbError::NotADirectory)
    }

    async fn close(self: Box<Self>) -> SmbResult<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::path::SmbPath;
    use crate::{LocalFsBackend, OpenIntent, OpenOptions, ShareBackend};

    #[tokio::test]
    async fn streams_persist_on_files_directories_and_root_without_changing_base_data() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("base"), b"original").unwrap();
        std::fs::create_dir(dir.path().join("folder")).unwrap();
        let backend = LocalFsBackend::new(dir.path()).unwrap();
        assert!(backend.capabilities().named_streams);
        let create = OpenOptions {
            write: true,
            intent: OpenIntent::Create,
            ..Default::default()
        };
        for base in ["base", "folder", ""] {
            let path: SmbPath = format!("{base}:com.apple.lastuseddate#PS:$DATA")
                .parse()
                .unwrap();
            let handle = backend.open(&path, create).await.unwrap();
            assert!(!handle.stat().await.unwrap().is_directory);
            assert!(matches!(
                backend.open(&path, create).await,
                Err(SmbError::Exists)
            ));
            assert_eq!(handle.write(0, b"metadata").await.unwrap(), 8);
            assert_eq!(handle.write(10, b"ok").await.unwrap(), 2);
            assert_eq!(
                handle.read(0, 100).await.unwrap().as_ref(),
                b"metadata\0\0ok"
            );
            assert_eq!(handle.read(u64::MAX, 1).await.unwrap().len(), 0);
            assert!(handle.write(u64::MAX, b"bad").await.is_err());
            assert!(handle.truncate(u64::MAX).await.is_err());
            handle.truncate(4).await.unwrap();
            handle.truncate(6).await.unwrap();
            assert_eq!(handle.read(0, 100).await.unwrap().as_ref(), b"meta\0\0");
            handle.flush().await.unwrap();
            handle.close().await.unwrap();

            let reopened_backend = LocalFsBackend::new(dir.path()).unwrap();
            let upper: SmbPath = format!("{base}:COM.APPLE.LASTUSEDDATE#PS:$DATA")
                .parse()
                .unwrap();
            let handle = reopened_backend
                .open(&upper, OpenOptions::default())
                .await
                .unwrap();
            assert_eq!(handle.read(0, 100).await.unwrap().as_ref(), b"meta\0\0");
            assert!(matches!(
                handle.write(0, b"no").await,
                Err(SmbError::AccessDenied)
            ));
            assert!(matches!(
                handle.truncate(0).await,
                Err(SmbError::AccessDenied)
            ));
            handle.close().await.unwrap();
            let base_handle = backend
                .open(&base.parse().unwrap(), OpenOptions::default())
                .await
                .unwrap();
            let streams = base_handle.list_streams().await.unwrap();
            assert!(streams.contains(&(":com.apple.lastuseddate#PS:$DATA".into(), 6)));
            if base == "base" {
                assert!(streams.contains(&("::$DATA".into(), 8)));
            }
            base_handle.close().await.unwrap();
            let read_only = LocalFsBackend::new(dir.path()).unwrap().read_only();
            assert!(matches!(
                read_only.open(&path, create).await,
                Err(SmbError::AccessDenied)
            ));
            assert!(matches!(
                read_only.unlink(&path).await,
                Err(SmbError::AccessDenied)
            ));
            backend.unlink(&upper).await.unwrap();
            assert!(matches!(
                backend.open(&path, OpenOptions::default()).await,
                Err(SmbError::NotFound)
            ));
        }
        assert_eq!(std::fs::read(dir.path().join("base")).unwrap(), b"original");
        assert!(dir.path().join("folder").is_dir());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[tokio::test]
    async fn stream_metadata_follows_base_rename_and_cannot_escape_the_share() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), b"untouched").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("escape")).unwrap();
        let backend = LocalFsBackend::new(dir.path()).unwrap();
        let create = OpenOptions {
            write: true,
            intent: OpenIntent::OpenOrCreate,
            ..Default::default()
        };
        assert!(
            backend
                .open(&"escape/secret:meta".parse().unwrap(), create)
                .await
                .is_err()
        );
        assert!(
            backend
                .unlink(&"escape/secret:meta".parse().unwrap())
                .await
                .is_err()
        );
        let handle = backend
            .open(&"base:meta".parse().unwrap(), create)
            .await
            .unwrap();
        handle.write(0, b"persist").await.unwrap();
        handle.close().await.unwrap();
        backend
            .rename(&"base".parse().unwrap(), &"renamed".parse().unwrap())
            .await
            .unwrap();
        let stream: SmbPath = "renamed:meta".parse().unwrap();
        let handle = backend.open(&stream, OpenOptions::default()).await.unwrap();
        assert_eq!(handle.read(0, 20).await.unwrap().as_ref(), b"persist");
        handle.close().await.unwrap();
        assert!(
            backend
                .rename(&stream, &"other".parse().unwrap())
                .await
                .is_err()
        );
        backend.unlink(&"renamed".parse().unwrap()).await.unwrap();
        assert!(backend.open(&stream, OpenOptions::default()).await.is_err());
        assert_eq!(
            std::fs::read(outside.path().join("secret")).unwrap(),
            b"untouched"
        );
    }
}
