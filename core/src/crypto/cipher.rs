// [xihanzu-NR]

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use ctr::cipher::{KeyIvInit, StreamCipher};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

use crate::crypto::CryptoError;

pub const GCM_TAG_LENGTH: usize = 16;
pub const IV_LENGTH: usize = 12;
pub const KEY_LENGTH: usize = 32;

type Aes256Ctr128BE = ctr::Ctr128BE<aes::Aes256>;
type HmacSha256 = Hmac<Sha256>;

pub fn generate_iv(counter: u32) -> [u8; IV_LENGTH] {
    let mut iv = [0u8; IV_LENGTH];
    iv[8..12].copy_from_slice(&counter.to_be_bytes());
    iv
}

pub fn aes_256_gcm_encrypt(
    plaintext: &[u8],
    key: &[u8; KEY_LENGTH],
    iv: &[u8; IV_LENGTH],
    additional_data: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;
    let nonce = Nonce::from(*iv);
    let payload = Payload {
        msg: plaintext,
        aad: additional_data,
    };
    cipher
        .encrypt(&nonce, payload)
        .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))
}

pub fn aes_256_gcm_decrypt(
    ciphertext: &[u8],
    key: &[u8; KEY_LENGTH],
    iv: &[u8; IV_LENGTH],
    additional_data: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    if ciphertext.len() < GCM_TAG_LENGTH {
        return Err(CryptoError::DecryptionFailed(
            "Ciphertext shorter than authentication tag".to_string(),
        ));
    }
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| CryptoError::DecryptionFailed(e.to_string()))?;
    let nonce = Nonce::from(*iv);
    let payload = Payload {
        msg: ciphertext,
        aad: additional_data,
    };
    cipher
        .decrypt(&nonce, payload)
        .map_err(|e| CryptoError::DecryptionFailed(e.to_string()))
}

pub fn aes_256_ctr_encrypt(
    plaintext: &[u8],
    key: &[u8; KEY_LENGTH],
    iv: &[u8; 16],
) -> Result<Vec<u8>, CryptoError> {
    let mut buffer = plaintext.to_vec();
    let mut cipher = Aes256Ctr128BE::new(key.into(), iv.into());
    cipher.apply_keystream(&mut buffer);
    Ok(buffer)
}

pub fn aes_256_ctr_decrypt(
    ciphertext: &[u8],
    key: &[u8; KEY_LENGTH],
    iv: &[u8; 16],
) -> Result<Vec<u8>, CryptoError> {
    aes_256_ctr_encrypt(ciphertext, key, iv)
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let result = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&result);
    out
}

pub fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(key)
        .expect("HMAC can take key of any size");
    mac.update(data);
    let result = mac.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&result.into_bytes());
    out
}

pub fn hkdf_sha256(
    ikm: &[u8],
    length: usize,
    salt: Option<&[u8]>,
    info: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let hk = Hkdf::<Sha256>::new(salt, ikm);
    let mut okm = vec![0u8; length];
    hk.expand(info, &mut okm)
        .map_err(|e| CryptoError::HkdfError(e.to_string()))?;
    Ok(okm)
}

pub fn hkdf_expand_64(salt: &[u8; 32], ikm: &[u8]) -> Result<([u8; 32], [u8; 32]), CryptoError> {
    let okm = hkdf_sha256(ikm, 64, Some(salt), b"")?;
    let mut write_key = [0u8; 32];
    let mut read_key = [0u8; 32];
    write_key.copy_from_slice(&okm[0..32]);
    read_key.copy_from_slice(&okm[32..64]);
    Ok((write_key, read_key))
}

pub fn derive_pairing_code_key(pairing_code: &str, salt: &[u8]) -> Result<[u8; 32], CryptoError> {
    let okm = hkdf_sha256(pairing_code.as_bytes(), 32, Some(salt), b"pairing_code_key")?;
    let mut key = [0u8; 32];
    key.copy_from_slice(&okm);
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_aes_gcm_roundtrip() {
        let key = [0x5au8; KEY_LENGTH];
        let iv = generate_iv(42);
        let plaintext = b"Hello WhatsApp Signal Security!";
        let aad = b"additional-authenticated-data";

        let ciphertext = aes_256_gcm_encrypt(plaintext, &key, &iv, aad).unwrap();
        assert_eq!(ciphertext.len(), plaintext.len() + GCM_TAG_LENGTH);

        let decrypted = aes_256_gcm_decrypt(&ciphertext, &key, &iv, aad).unwrap();
        assert_eq!(&decrypted[..], plaintext);
    }

    #[test]
    fn test_aes_gcm_tamper_fails() {
        let key = [0x42u8; KEY_LENGTH];
        let iv = generate_iv(1);
        let plaintext = b"Message that will be tampered";
        let aad = b"auth";

        let mut ciphertext = aes_256_gcm_encrypt(plaintext, &key, &iv, aad).unwrap();
        ciphertext[0] ^= 0xff; // tamper

        let res = aes_256_gcm_decrypt(&ciphertext, &key, &iv, aad);
        assert!(res.is_err());
    }

    #[test]
    fn test_aes_ctr_roundtrip() {
        let key = [0x33u8; KEY_LENGTH];
        let iv = [0x77u8; 16];
        let plaintext = b"Stream cipher encrypted frame data";

        let enc = aes_256_ctr_encrypt(plaintext, &key, &iv).unwrap();
        assert_ne!(&enc[..], plaintext);

        let dec = aes_256_ctr_decrypt(&enc, &key, &iv).unwrap();
        assert_eq!(&dec[..], plaintext);
    }

    #[test]
    fn test_sha256() {
        let h = sha256(b"whatsapp");
        assert_eq!(hex::encode(h), "ec8202b6f9fb16f9e26b66367afa4e037752f3c09a18cefab426165e06a424b1");
    }

    #[test]
    fn test_hkdf_expand_64() {
        let salt = [0x11u8; 32];
        let ikm = b"secret-shared-diffie-hellman";
        let (w, r) = hkdf_expand_64(&salt, ikm).unwrap();
        assert_ne!(w, r);
        assert_ne!(w, [0u8; 32]);
        assert_ne!(r, [0u8; 32]);
    }
}
