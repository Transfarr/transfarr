//! Local-filesystem [`ShareBackend`] for `smb-server`, sandboxed via `cap-std`.

mod local;
mod streams;

pub use local::LocalFsBackend;
