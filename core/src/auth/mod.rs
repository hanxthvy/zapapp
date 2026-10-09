// [xihanzu-NR]
//! WhatsApp Companion Device Authentication & Pairing Subsystem.
//! Implements QR code matrix encoding/parsing, SVG / Data URL generation,
//! 8-digit mobile pairing codes, and companion registration state machine.

pub mod pairing;
pub mod qr;

pub use pairing::{
    normalize_phone_number, CompanionRegistrationStateMachine, PairingCode, PairingCodeSession,
    PairingError, PairingMethod, RegistrationState, ALPHANUMERIC_PAIRING_CHARSET,
    DEFAULT_MAX_VERIFICATION_ATTEMPTS, DEFAULT_PAIRING_CODE_TTL_SECS, DEFAULT_QR_TTL_SECS,
};
pub use qr::{
    base64_decode, base64_encode, encode_to_matrix, QrEcLevel, QrError, QrMatrix,
    QrPairingPayload, SvgOptions,
};

use rand::Rng;

use crate::crypto::curve::{
    generate_ed25519_key_pair, generate_key_pair, signed_key_pair, KeyPair, SignedKeyPair,
};
use crate::store::schema::AuthCredentials;

/// Unified authentication error type.
#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("QR Code error: {0}")]
    Qr(#[from] QrError),

    #[error("Pairing error: {0}")]
    Pairing(#[from] PairingError),

    #[error("Crypto error: {0}")]
    Crypto(#[from] crate::crypto::CryptoError),

    #[error("State machine error: {0}")]
    InvalidState(String),
}

/// Active Companion Authentication Session combining device cryptographic keys,
/// pairing state machine, and persistence bridge.
#[derive(Clone, Debug)]
pub struct AuthSession {
    pub registration_id: u32,
    pub noise_key: KeyPair,
    pub identity_key: KeyPair,
    pub signed_prekey: SignedKeyPair,
    pub adv_secret: [u8; 32],
    pub state_machine: CompanionRegistrationStateMachine,
}

impl AuthSession {
    /// Initializes a new companion authentication session with freshly generated
    /// Curve25519 Noise key pair, Ed25519 identity key, and signed prekey.
    pub fn new(registration_id: u32) -> Result<Self, AuthError> {
        let noise_key = generate_key_pair();
        let identity_key = generate_ed25519_key_pair();
        let signed_prekey = signed_key_pair(&identity_key, 1)?;

        let mut adv_secret = [0u8; 32];
        rand::rng().fill_bytes(&mut adv_secret);

        Ok(Self {
            registration_id,
            noise_key,
            identity_key,
            signed_prekey,
            adv_secret,
            state_machine: CompanionRegistrationStateMachine::new(),
        })
    }

    /// Starts QR pairing flow. Returns the comma-separated WhatsApp QR string.
    pub fn start_qr(
        &mut self,
        ref_id: &str,
        ttl_seconds: u64,
        now: u64,
    ) -> Result<String, AuthError> {
        let payload = self.state_machine.start_qr(
            ref_id.to_string(),
            self.noise_key.public,
            self.identity_key.public,
            Some(self.adv_secret),
            ttl_seconds,
            now,
        )?;
        Ok(payload.to_qr_string())
    }

    /// Refreshes the active QR code with a new server reference token.
    pub fn refresh_qr(
        &mut self,
        new_ref_id: &str,
        ttl_seconds: u64,
        now: u64,
    ) -> Result<String, AuthError> {
        let payload = self
            .state_machine
            .refresh_qr(new_ref_id.to_string(), ttl_seconds, now)?;
        Ok(payload.to_qr_string())
    }

    /// Generates SVG markup for the current active QR code.
    pub fn get_qr_svg(&self, options: &SvgOptions) -> Result<String, AuthError> {
        let qr_str = self
            .state_machine
            .current_qr_payload()
            .ok_or_else(|| AuthError::InvalidState("No active QR pairing session".to_string()))?;
        let payload = QrPairingPayload::parse(qr_str)?;
        let svg = payload.to_svg(options)?;
        Ok(svg)
    }

    /// Generates Data URL for the current active QR code.
    pub fn get_qr_data_url(&self, options: &SvgOptions) -> Result<String, AuthError> {
        let qr_str = self
            .state_machine
            .current_qr_payload()
            .ok_or_else(|| AuthError::InvalidState("No active QR pairing session".to_string()))?;
        let payload = QrPairingPayload::parse(qr_str)?;
        let data_url = payload.to_data_url(options)?;
        Ok(data_url)
    }

    /// Starts 8-digit mobile pairing code flow. Returns formatted code `"XXXX-XXXX"`.
    pub fn start_pairing_code(
        &mut self,
        phone_number: &str,
        ttl_seconds: u64,
        now: u64,
    ) -> Result<String, AuthError> {
        let code = self.state_machine.start_pairing_code(
            phone_number,
            self.noise_key.public,
            self.identity_key.public,
            ttl_seconds,
            now,
        )?;
        Ok(code.formatted())
    }

    /// Verifies candidate pairing code entered on phone or companion.
    pub fn verify_pairing_code(&mut self, candidate: &str, now: u64) -> Result<bool, AuthError> {
        let matched = self
            .state_machine
            .verify_pairing_code(candidate, now)?;
        Ok(matched)
    }

    /// Advances state when QR code is scanned by companion.
    pub fn on_qr_scanned(
        &mut self,
        client_ephemeral: [u8; 32],
        now: u64,
    ) -> Result<(), AuthError> {
        self.state_machine
            .on_qr_scanned(client_ephemeral, now)?;
        Ok(())
    }

    /// Advances state when Noise cryptographic handshake finishes.
    pub fn on_handshake_complete(
        &mut self,
        client_static_pub: [u8; 32],
        companion_jid: Option<String>,
        now: u64,
    ) -> Result<(), AuthError> {
        self.state_machine
            .on_handshake_complete(client_static_pub, companion_jid, now)?;
        Ok(())
    }

    /// Completes companion registration and marks session as Paired.
    pub fn complete_registration(
        &mut self,
        companion_jid: &str,
        lid: Option<&str>,
        device_id: u32,
        now: u64,
    ) -> Result<(), AuthError> {
        self.state_machine.on_registration_success(
            companion_jid.to_string(),
            lid.map(|s| s.to_string()),
            device_id,
            now,
        )?;
        Ok(())
    }

    /// Exports paired credentials to `AuthCredentials` for persistence in SQLite database.
    pub fn to_auth_credentials(&self, id: &str, now: i64) -> Result<AuthCredentials, AuthError> {
        let (jid, lid, _dev_id) = self
            .state_machine
            .paired_info()
            .ok_or_else(|| AuthError::InvalidState("Session is not yet paired".to_string()))?;

        Ok(AuthCredentials {
            id: id.to_string(),
            registration_id: self.registration_id,
            noise_key: self.noise_key.private.to_vec(),
            identity_key: self.identity_key.private.to_vec(),
            signed_prekey: self.signed_prekey.key_pair.private.to_vec(),
            signed_prekey_id: self.signed_prekey.key_id,
            signed_prekey_sig: self.signed_prekey.signature.to_vec(),
            adv_secret_key: Some(self.adv_secret.to_vec()),
            me_jid: Some(jid.to_string()),
            me_lid: lid.map(|s| s.to_string()),
            me_name: None,
            account_sync_counter: 0,
            platform: Some("zapapp-desktop".to_string()),
            tokens: None,
            created_at: now,
            updated_at: now,
        })
    }
}

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_auth_session_qr_workflow() {
        let mut session = AuthSession::new(12345).unwrap();
        assert!(session.state_machine.is_idle());

        let qr_str = session.start_qr("ref_token_1", 60, 1000).unwrap();
        assert!(qr_str.starts_with("ref_token_1"));

        let svg = session.get_qr_svg(&SvgOptions::default()).unwrap();
        assert!(svg.contains("<svg"));

        let data_url = session.get_qr_data_url(&SvgOptions::default()).unwrap();
        assert!(data_url.starts_with("data:image/svg+xml;base64,"));

        session.on_qr_scanned([0x11; 32], 1020).unwrap();
        session
            .on_handshake_complete(
                [0x22; 32],
                Some("5511999998888@s.whatsapp.net".to_string()),
                1030,
            )
            .unwrap();
        session
            .complete_registration(
                "5511999998888:1@s.whatsapp.net",
                Some("5511999998888@lid"),
                1,
                1040,
            )
            .unwrap();

        assert!(session.state_machine.is_paired());
        let creds = session.to_auth_credentials("test_session_id", 1040).unwrap();
        assert_eq!(creds.id, "test_session_id");
        assert_eq!(creds.me_jid.as_deref(), Some("5511999998888:1@s.whatsapp.net"));
        assert_eq!(creds.me_lid.as_deref(), Some("5511999998888@lid"));
    }

    #[test]
    fn test_auth_session_pairing_code_workflow() {
        let mut session = AuthSession::new(67890).unwrap();

        let code_fmt = session
            .start_pairing_code("+55 11 99999-8888", 160, 2000)
            .unwrap();
        assert_eq!(code_fmt.len(), 9);

        let ok = session.verify_pairing_code(&code_fmt, 2010).unwrap();
        assert!(ok);

        session.on_handshake_complete([0x33; 32], None, 2020).unwrap();
        session
            .complete_registration("5511999998888:0@s.whatsapp.net", None, 0, 2030)
            .unwrap();

        assert!(session.state_machine.is_paired());
        let creds = session.to_auth_credentials("code_session", 2030).unwrap();
        assert_eq!(creds.me_jid.as_deref(), Some("5511999998888:0@s.whatsapp.net"));
    }
}
