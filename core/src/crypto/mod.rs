// [xihanzu-NR]

pub mod cipher;
pub mod curve;
pub mod noise;

pub use cipher::*;
pub use curve::*;
pub use noise::*;

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("Invalid key length: expected {expected}, got {actual}")]
    InvalidKeyLength { expected: usize, actual: usize },

    #[error("Invalid public key")]
    InvalidPublicKey,

    #[error("Invalid signature")]
    InvalidSignature,

    #[error("Encryption failed: {0}")]
    EncryptionFailed(String),

    #[error("Decryption failed: {0}")]
    DecryptionFailed(String),

    #[error("HKDF error: {0}")]
    HkdfError(String),

    #[error("Noise handshake error: {0}")]
    NoiseHandshakeError(String),

    #[error("Certificate verification failed: {0}")]
    CertificateVerificationFailed(String),

    #[error("Protocol error: {0}")]
    ProtocolError(String),
}
