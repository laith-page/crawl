//! The trust store: system CAs, or SSL_CERT_FILE when set (DESIGN §1).

use reqwest::ClientBuilder;
use rustls::crypto::{CryptoProvider, ring::kx_group};
use std::{ffi::OsString, sync::Arc};

pub struct Tls {
    cert_file: Option<OsString>,
}

impl Tls {
    pub fn new(cert_file: Option<OsString>) -> Self {
        Self { cert_file }
    }

    /// Client TLS configuration with X25519 then P-256 key exchange (DESIGN §5).
    pub fn load(&self, builder: ClientBuilder) -> Result<ClientBuilder, String> {
        let provider = Arc::new(CryptoProvider {
            kx_groups: vec![kx_group::X25519, kx_group::SECP256R1],
            ..rustls::crypto::ring::default_provider()
        });
        let mut config =
            certs::client_config(self.cert_file.as_deref(), provider).map_err(|e| e.to_string())?;
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(builder.tls_backend_preconfigured(config))
    }
}
