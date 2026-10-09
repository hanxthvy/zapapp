// [xihanzu-NR]

use curve25519_dalek::montgomery::MontgomeryPoint;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::Rng;
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret};

use crate::crypto::CryptoError;

pub const KEY_BUNDLE_TYPE: u8 = 5;
pub const CURVE_KEY_LENGTH: usize = 32;
pub const SIGNATURE_LENGTH: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyPair {
    pub public: [u8; 32],
    pub private: [u8; 32],
}

impl KeyPair {
    pub fn new(public: [u8; 32], private: [u8; 32]) -> Self {
        Self { public, private }
    }

    pub fn generate() -> Self {
        generate_key_pair()
    }

    pub fn from_private(private: &[u8; 32]) -> Self {
        key_pair_from_private(private)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedKeyPair {
    pub key_pair: KeyPair,
    pub signature: [u8; 64],
    pub key_id: u32,
}

pub fn scrub_pub_key(pub_key: &[u8]) -> Result<[u8; 32], CryptoError> {
    if pub_key.len() == 33 && pub_key[0] == KEY_BUNDLE_TYPE {
        let mut pk = [0u8; 32];
        pk.copy_from_slice(&pub_key[1..33]);
        Ok(pk)
    } else if pub_key.len() == 32 {
        let mut pk = [0u8; 32];
        pk.copy_from_slice(pub_key);
        Ok(pk)
    } else {
        Err(CryptoError::InvalidKeyLength {
            expected: 32,
            actual: pub_key.len(),
        })
    }
}

pub fn generate_signal_pub_key(pub_key: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if pub_key.len() == 33 && pub_key[0] == KEY_BUNDLE_TYPE {
        Ok(pub_key.to_vec())
    } else if pub_key.len() == 32 {
        let mut res = Vec::with_capacity(33);
        res.push(KEY_BUNDLE_TYPE);
        res.extend_from_slice(pub_key);
        Ok(res)
    } else {
        Err(CryptoError::InvalidKeyLength {
            expected: 32,
            actual: pub_key.len(),
        })
    }
}

pub fn generate_key_pair() -> KeyPair {
    let mut priv_bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut priv_bytes);
    key_pair_from_private(&priv_bytes)
}

pub fn key_pair_from_private(private_key: &[u8; 32]) -> KeyPair {
    let secret = StaticSecret::from(*private_key);
    let public = X25519PublicKey::from(&secret);
    KeyPair {
        public: *public.as_bytes(),
        private: *private_key,
    }
}

pub fn generate_ed25519_key_pair() -> KeyPair {
    let mut seed = [0u8; 32];
    rand::rng().fill_bytes(&mut seed);
    ed25519_key_pair_from_seed(&seed)
}

pub fn ed25519_key_pair_from_seed(seed: &[u8; 32]) -> KeyPair {
    let signing_key = SigningKey::from_bytes(seed);
    let verifying_key = signing_key.verifying_key();
    KeyPair {
        public: *verifying_key.as_bytes(),
        private: *seed,
    }
}

pub fn calculate_agreement(private_key: &[u8; 32], public_key: &[u8]) -> Result<[u8; 32], CryptoError> {
    let pk32 = scrub_pub_key(public_key)?;
    let secret = StaticSecret::from(*private_key);
    let pub_pt = X25519PublicKey::from(pk32);
    let shared = secret.diffie_hellman(&pub_pt);
    Ok(*shared.as_bytes())
}

pub fn shared_key(private_key: &[u8; 32], public_key: &[u8]) -> Result<[u8; 32], CryptoError> {
    calculate_agreement(private_key, public_key)
}

pub fn sign(private_key: &[u8; 32], message: &[u8]) -> Result<[u8; 64], CryptoError> {
    let signing_key = SigningKey::from_bytes(private_key);
    let signature = signing_key.sign(message);
    Ok(signature.to_bytes())
}

pub fn verify(public_key: &[u8], message: &[u8], signature: &[u8; 64]) -> bool {
    let pk32 = match scrub_pub_key(public_key) {
        Ok(pk) => pk,
        Err(_) => return false,
    };

    // 1. Try standard Ed25519 verification
    if let Ok(vk) = VerifyingKey::from_bytes(&pk32) {
        if let Ok(sig) = Signature::try_from(signature.as_slice()) {
            if vk.verify(message, &sig).is_ok() {
                return true;
            }
        }
    }

    // 2. Try XEd25519 / Curve25519 Montgomery -> Edwards conversion
    let sign_bit = (signature[63] >> 7) & 1;
    let mont = MontgomeryPoint(pk32);
    if let Some(ed_pt) = mont.to_edwards(sign_bit) {
        let mut clean_sig = *signature;
        clean_sig[63] &= 0x7f;
        let ed_bytes = ed_pt.compress().to_bytes();
        if let Ok(vk) = VerifyingKey::from_bytes(&ed_bytes) {
            if let Ok(sig) = Signature::try_from(clean_sig.as_slice()) {
                if vk.verify(message, &sig).is_ok() {
                    return true;
                }
            }
        }
    }

    false
}

pub fn signed_key_pair(identity_key_pair: &KeyPair, key_id: u32) -> Result<SignedKeyPair, CryptoError> {
    let pre_key = generate_key_pair();
    let signal_pub = generate_signal_pub_key(&pre_key.public)?;
    let signature = sign(&identity_key_pair.private, &signal_pub)?;
    Ok(SignedKeyPair {
        key_pair: pre_key,
        signature,
        key_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ecdh_roundtrip() {
        let alice = generate_key_pair();
        let bob = generate_key_pair();
        let s1 = shared_key(&alice.private, &bob.public).unwrap();
        let s2 = shared_key(&bob.private, &alice.public).unwrap();
        assert_eq!(s1, s2);
        assert_ne!(s1, [0u8; 32]);
    }

    #[test]
    fn test_ecdh_with_33_byte_signal_key() {
        let alice = generate_key_pair();
        let bob = generate_key_pair();
        let bob_signal_pub = generate_signal_pub_key(&bob.public).unwrap();
        assert_eq!(bob_signal_pub.len(), 33);
        assert_eq!(bob_signal_pub[0], KEY_BUNDLE_TYPE);

        let s1 = shared_key(&alice.private, &bob_signal_pub).unwrap();
        let s2 = shared_key(&bob.private, &alice.public).unwrap();
        assert_eq!(s1, s2);
    }

    #[test]
    fn test_ed25519_sign_and_verify() {
        let keys = generate_ed25519_key_pair();
        let msg = b"whatsapp-payload-to-sign";
        let sig = sign(&keys.private, msg).unwrap();
        assert!(verify(&keys.public, msg, &sig));
        assert!(!verify(&keys.public, b"altered-payload", &sig));
    }

    #[test]
    fn test_signed_key_pair() {
        let identity = generate_ed25519_key_pair();
        let signed = signed_key_pair(&identity, 42).unwrap();
        assert_eq!(signed.key_id, 42);
        let signal_pub = generate_signal_pub_key(&signed.key_pair.public).unwrap();
        assert!(verify(&identity.public, &signal_pub, &signed.signature));
    }
}
