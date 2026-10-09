// [xihanzu-NR]
//! Unit tests for Curve25519 ECDH key exchange and AES-256-GCM cryptography.

use zapapp_core::crypto::cipher::{
    aes_256_gcm_decrypt, aes_256_gcm_encrypt, generate_iv, GCM_TAG_LENGTH, IV_LENGTH, KEY_LENGTH,
};
use zapapp_core::crypto::curve::{
    calculate_agreement, generate_key_pair, generate_signal_pub_key, key_pair_from_private,
    scrub_pub_key, shared_key, KEY_BUNDLE_TYPE,
};
use zapapp_core::crypto::CryptoError;

// ---------------------------------------------------------------------------
// Curve25519 ECDH Key Exchange Test Vectors
// ---------------------------------------------------------------------------

#[test]
fn test_curve25519_rfc7748_section_6_1_vector() {
    // RFC 7748 Section 6.1 Curve25519 Diffie-Hellman test vector
    let alice_priv_bytes =
        hex::decode("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a").unwrap();
    let bob_priv_bytes =
        hex::decode("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb").unwrap();

    let mut alice_priv = [0u8; 32];
    alice_priv.copy_from_slice(&alice_priv_bytes);
    let mut bob_priv = [0u8; 32];
    bob_priv.copy_from_slice(&bob_priv_bytes);

    // 1. Derive public keys from private scalars
    let alice_pair = key_pair_from_private(&alice_priv);
    let bob_pair = key_pair_from_private(&bob_priv);

    let expected_alice_pub =
        "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a";
    let expected_bob_pub =
        "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f";

    assert_eq!(hex::encode(alice_pair.public), expected_alice_pub);
    assert_eq!(hex::encode(bob_pair.public), expected_bob_pub);

    // 2. Perform ECDH key exchange from both sides
    let shared_ab = shared_key(&alice_priv, &bob_pair.public).expect("Alice ECDH failed");
    let shared_ba = shared_key(&bob_priv, &alice_pair.public).expect("Bob ECDH failed");

    let expected_shared =
        "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";
    assert_eq!(hex::encode(shared_ab), expected_shared);
    assert_eq!(hex::encode(shared_ba), expected_shared);
    assert_eq!(shared_ab, shared_ba);

    // 3. calculate_agreement equivalence
    let agree_ab = calculate_agreement(&alice_priv, &bob_pair.public).unwrap();
    let agree_ba = calculate_agreement(&bob_priv, &alice_pair.public).unwrap();
    assert_eq!(agree_ab, shared_ab);
    assert_eq!(agree_ba, shared_ba);
}

#[test]
fn test_curve25519_rfc7748_section_5_2_vectors() {
    // Vector 1
    let scalar1_bytes =
        hex::decode("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4").unwrap();
    let u1_bytes =
        hex::decode("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c").unwrap();
    let mut scalar1 = [0u8; 32];
    scalar1.copy_from_slice(&scalar1_bytes);

    let out1 = calculate_agreement(&scalar1, &u1_bytes).expect("Vector 1 failed");
    assert_eq!(
        hex::encode(out1),
        "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552"
    );

    // Vector 2
    let scalar2_bytes =
        hex::decode("4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d").unwrap();
    let u2_bytes =
        hex::decode("e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493").unwrap();
    let mut scalar2 = [0u8; 32];
    scalar2.copy_from_slice(&scalar2_bytes);

    let out2 = calculate_agreement(&scalar2, &u2_bytes).expect("Vector 2 failed");
    assert_eq!(
        hex::encode(out2),
        "95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957"
    );
}

#[test]
fn test_curve25519_with_33_byte_signal_prefix() {
    let alice_priv_bytes =
        hex::decode("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a").unwrap();
    let bob_priv_bytes =
        hex::decode("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb").unwrap();

    let mut alice_priv = [0u8; 32];
    alice_priv.copy_from_slice(&alice_priv_bytes);
    let mut bob_priv = [0u8; 32];
    bob_priv.copy_from_slice(&bob_priv_bytes);

    let alice_pub = key_pair_from_private(&alice_priv).public;
    let bob_pub = key_pair_from_private(&bob_priv).public;

    // Convert Bob's public key to 33-byte Signal protocol format (0x05 prefix)
    let bob_signal_pub = generate_signal_pub_key(&bob_pub).unwrap();
    assert_eq!(bob_signal_pub.len(), 33);
    assert_eq!(bob_signal_pub[0], KEY_BUNDLE_TYPE);
    assert_eq!(&bob_signal_pub[1..], &bob_pub);

    // Alice calculates shared secret with Bob's 33-byte Signal key
    let shared_from_signal = shared_key(&alice_priv, &bob_signal_pub).unwrap();
    let shared_ba = shared_key(&bob_priv, &alice_pub).unwrap();
    let expected_shared =
        "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";
    assert_eq!(hex::encode(shared_from_signal), expected_shared);
    assert_eq!(shared_ba, shared_from_signal);

    // Scrub key works on both 32-byte and 33-byte formats
    let scrubbed_32 = scrub_pub_key(&bob_pub).unwrap();
    let scrubbed_33 = scrub_pub_key(&bob_signal_pub).unwrap();
    assert_eq!(scrubbed_32, bob_pub);
    assert_eq!(scrubbed_33, bob_pub);
}

#[test]
fn test_curve25519_random_key_exchange_symmetry() {
    for _ in 0..10 {
        let alice = generate_key_pair();
        let bob = generate_key_pair();

        assert_ne!(alice.public, [0u8; 32]);
        assert_ne!(bob.public, [0u8; 32]);

        let shared_ab = shared_key(&alice.private, &bob.public).unwrap();
        let shared_ba = shared_key(&bob.private, &alice.public).unwrap();

        assert_eq!(shared_ab, shared_ba);
        assert_ne!(shared_ab, [0u8; 32]);
    }
}

#[test]
fn test_curve25519_invalid_key_lengths() {
    let key = [0x42u8; 32];

    // Key too short
    assert!(matches!(
        calculate_agreement(&key, &[0u8; 16]),
        Err(CryptoError::InvalidKeyLength { expected: 32, actual: 16 })
    ));

    // Key 31 bytes
    assert!(matches!(
        calculate_agreement(&key, &[0u8; 31]),
        Err(CryptoError::InvalidKeyLength { expected: 32, actual: 31 })
    ));

    // Key 34 bytes
    assert!(matches!(
        calculate_agreement(&key, &[0u8; 34]),
        Err(CryptoError::InvalidKeyLength { expected: 32, actual: 34 })
    ));

    // 33-byte key with wrong prefix (not KEY_BUNDLE_TYPE = 5)
    let mut invalid_33 = [0u8; 33];
    invalid_33[0] = 0x04;
    assert!(matches!(
        calculate_agreement(&key, &invalid_33),
        Err(CryptoError::InvalidKeyLength { .. })
    ));
}

// ---------------------------------------------------------------------------
// AES-256-GCM Encryption / Decryption Tests
// ---------------------------------------------------------------------------

#[test]
fn test_aes_256_gcm_nist_sp800_38d_test_case_14() {
    // NIST SP 800-38D Test Case 14 (256-bit key, 96-bit IV, 128-bit PT, empty AAD)
    let key = [0u8; KEY_LENGTH];
    let iv = [0u8; IV_LENGTH];
    let plaintext = [0u8; 16];
    let aad = b"";

    let ciphertext = aes_256_gcm_encrypt(&plaintext, &key, &iv, aad).expect("encryption failed");
    assert_eq!(ciphertext.len(), plaintext.len() + GCM_TAG_LENGTH);

    let expected_hex = "cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919";
    assert_eq!(hex::encode(&ciphertext), expected_hex);

    let decrypted = aes_256_gcm_decrypt(&ciphertext, &key, &iv, aad).expect("decryption failed");
    assert_eq!(&decrypted[..], &plaintext[..]);
}

#[test]
fn test_aes_256_gcm_nist_sp800_38d_test_case_16_with_aad() {
    // NIST SP 800-38D Test Case 16 (256-bit key, 96-bit IV, 64-byte PT, 20-byte AAD)
    let key_bytes =
        hex::decode("feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308").unwrap();
    let iv_bytes = hex::decode("cafebabefacedbaddecaf888").unwrap();
    let pt_bytes = hex::decode(
        "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a72\
         1c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b391aafd255",
    )
    .unwrap();
    let aad_bytes = hex::decode("feedfacedeadbeeffeedfacedeadbeefabaddcad").unwrap();

    let mut key = [0u8; KEY_LENGTH];
    key.copy_from_slice(&key_bytes);
    let mut iv = [0u8; IV_LENGTH];
    iv.copy_from_slice(&iv_bytes);

    let ciphertext = aes_256_gcm_encrypt(&pt_bytes, &key, &iv, &aad_bytes).unwrap();
    let expected_ct_hex = concat!(
        "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa",
        "8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662898015ad",
        "228ccf2c513771ab819ac64929d9f492"
    );
    assert_eq!(hex::encode(&ciphertext), expected_ct_hex);

    let decrypted = aes_256_gcm_decrypt(&ciphertext, &key, &iv, &aad_bytes).unwrap();
    assert_eq!(decrypted, pt_bytes);
}

#[test]
fn test_aes_256_gcm_empty_plaintext_roundtrip() {
    let key = [0x55u8; KEY_LENGTH];
    let iv = generate_iv(1);
    let empty_pt = b"";
    let aad = b"header_data";

    let ciphertext = aes_256_gcm_encrypt(empty_pt, &key, &iv, aad).unwrap();
    assert_eq!(ciphertext.len(), GCM_TAG_LENGTH);

    let decrypted = aes_256_gcm_decrypt(&ciphertext, &key, &iv, aad).unwrap();
    assert!(decrypted.is_empty());
}

#[test]
fn test_aes_256_gcm_multi_payload_roundtrip() {
    let key = [0x37u8; KEY_LENGTH];
    let iv = generate_iv(42);

    let payloads: Vec<Vec<u8>> = vec![
        b"short".to_vec(),
        b"Hello WhatsApp / ZapApp Signal Cryptography Layer!".to_vec(),
        vec![0xAA; 1024],
        vec![0x5A; 65536],
    ];

    for pt in payloads {
        let aad = b"authenticated_additional_data";
        let ct = aes_256_gcm_encrypt(&pt, &key, &iv, aad).expect("encryption failed");
        assert_eq!(ct.len(), pt.len() + GCM_TAG_LENGTH);

        let dt = aes_256_gcm_decrypt(&ct, &key, &iv, aad).expect("decryption failed");
        assert_eq!(dt, pt);
    }
}

#[test]
fn test_aes_256_gcm_iv_generation_counter() {
    let iv0 = generate_iv(0);
    assert_eq!(iv0, [0u8; IV_LENGTH]);

    let iv1 = generate_iv(1);
    assert_eq!(iv1[11], 1);
    assert_eq!(&iv1[0..8], &[0u8; 8]);

    let iv_max = generate_iv(u32::MAX);
    assert_eq!(&iv_max[8..12], &[0xff, 0xff, 0xff, 0xff]);
    assert_eq!(&iv_max[0..8], &[0u8; 8]);
}

#[test]
fn test_aes_256_gcm_authentication_failure_modes() {
    let key = [0x7au8; KEY_LENGTH];
    let iv = generate_iv(100);
    let pt = b"Critical security message to protect against tampering";
    let aad = b"zapapp-stanza-aad";

    let ct = aes_256_gcm_encrypt(pt, &key, &iv, aad).unwrap();

    // 1. Bit flip in ciphertext body
    let mut tampered_body = ct.clone();
    tampered_body[0] ^= 0x01;
    assert!(matches!(
        aes_256_gcm_decrypt(&tampered_body, &key, &iv, aad),
        Err(CryptoError::DecryptionFailed(_))
    ));

    // 2. Bit flip in authentication tag (last 16 bytes)
    let mut tampered_tag = ct.clone();
    let tag_idx = tampered_tag.len() - 1;
    tampered_tag[tag_idx] ^= 0x80;
    assert!(matches!(
        aes_256_gcm_decrypt(&tampered_tag, &key, &iv, aad),
        Err(CryptoError::DecryptionFailed(_))
    ));

    // 3. Altered AAD
    assert!(matches!(
        aes_256_gcm_decrypt(&ct, &key, &iv, b"different-aad"),
        Err(CryptoError::DecryptionFailed(_))
    ));
    assert!(matches!(
        aes_256_gcm_decrypt(&ct, &key, &iv, b""),
        Err(CryptoError::DecryptionFailed(_))
    ));

    // 4. Wrong key
    let mut wrong_key = key;
    wrong_key[0] ^= 0xff;
    assert!(matches!(
        aes_256_gcm_decrypt(&ct, &wrong_key, &iv, aad),
        Err(CryptoError::DecryptionFailed(_))
    ));

    // 5. Wrong IV
    let wrong_iv = generate_iv(101);
    assert!(matches!(
        aes_256_gcm_decrypt(&ct, &key, &wrong_iv, aad),
        Err(CryptoError::DecryptionFailed(_))
    ));

    // 6. Truncated ciphertext (< 16 bytes tag)
    let short_ct = vec![0u8; 15];
    assert!(matches!(
        aes_256_gcm_decrypt(&short_ct, &key, &iv, aad),
        Err(CryptoError::DecryptionFailed(_))
    ));
}
