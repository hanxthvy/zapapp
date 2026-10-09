// [xihanzu-NR]
//! WhatsApp Companion Device Registration State Machine and 8-Digit Mobile
//! Pairing Code Generation and Constant-Time Verification Protocol.

use rand::Rng;
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

use crate::auth::qr::QrPairingPayload;
use crate::crypto::cipher::derive_pairing_code_key;

/// Default time-to-live for mobile pairing codes (160 seconds per WhatsApp MD spec).
pub const DEFAULT_PAIRING_CODE_TTL_SECS: u64 = 160;
/// Default time-to-live for QR pairing tokens (60 seconds).
pub const DEFAULT_QR_TTL_SECS: u64 = 60;
/// Default maximum verification attempts before locking out the pairing code.
pub const DEFAULT_MAX_VERIFICATION_ATTEMPTS: u32 = 5;

/// WhatsApp pairing charset omitting ambiguous characters (0, O, 1, I).
pub const ALPHANUMERIC_PAIRING_CHARSET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/// Errors occurring during pairing code operations or registration transitions.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PairingError {
    #[error("Invalid pairing code: {0}")]
    InvalidCodeFormat(String),

    #[error("Pairing code expired at {expired_at}, current time is {now}")]
    Expired { expired_at: u64, now: u64 },

    #[error("Maximum verification attempts ({max}) exceeded")]
    MaxAttemptsExceeded { max: u32 },

    #[error("Invalid registration state transition from '{from}' via '{event}'")]
    InvalidStateTransition { from: String, event: String },

    #[error("Cryptographic derivation failed: {0}")]
    CryptoError(String),

    #[error("Invalid phone number: {0}")]
    InvalidPhoneNumber(String),

    #[error("Candidate code mismatch")]
    CodeMismatch,

    #[error("Pairing session is not in active state")]
    SessionNotActive,
}

// ---------------------------------------------------------------------------
// 8-Digit Mobile Pairing Code
// ---------------------------------------------------------------------------

/// Normalized 8-character/digit pairing code.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairingCode {
    /// Exactly 8 uppercase alphanumeric / numeric characters without whitespace.
    raw: String,
}

impl PairingCode {
    /// Creates a pairing code from raw or formatted string.
    /// Strips spaces and hyphens, converts to uppercase, and verifies length is exactly 8.
    pub fn new(code: &str) -> Result<Self, PairingError> {
        let cleaned: String = code
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '-')
            .flat_map(|c| c.to_uppercase())
            .collect();

        if cleaned.len() != 8 {
            return Err(PairingError::InvalidCodeFormat(format!(
                "Expected 8 characters, got {} ('{}')",
                cleaned.len(),
                code
            )));
        }

        if !cleaned.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(PairingError::InvalidCodeFormat(
                "Code must contain only alphanumeric characters".to_string(),
            ));
        }

        Ok(Self { raw: cleaned })
    }

    /// Generates a cryptographically secure 8-digit numeric pairing code (0-9).
    pub fn generate_numeric() -> Self {
        let mut bytes = [0u8; 8];
        rand::rng().fill_bytes(&mut bytes);
        let mut raw = String::with_capacity(8);
        for b in bytes {
            let digit = (b % 10) as u8;
            raw.push((b'0' + digit) as char);
        }
        Self { raw }
    }

    /// Generates a cryptographically secure 8-character WhatsApp alphanumeric code.
    pub fn generate_alphanumeric() -> Self {
        let mut bytes = [0u8; 8];
        rand::rng().fill_bytes(&mut bytes);
        let mut raw = String::with_capacity(8);
        for b in bytes {
            let idx = (b as usize) % ALPHANUMERIC_PAIRING_CHARSET.len();
            raw.push(ALPHANUMERIC_PAIRING_CHARSET[idx] as char);
        }
        Self { raw }
    }

    /// Default generator: returns an 8-digit numeric code.
    pub fn generate() -> Self {
        Self::generate_numeric()
    }

    /// Returns the raw 8-character code.
    pub fn raw(&self) -> &str {
        &self.raw
    }

    /// Returns human-readable formatted code with hyphen separator: `"XXXX-XXXX"`.
    pub fn formatted(&self) -> String {
        format!("{}-{}", &self.raw[..4], &self.raw[4..])
    }

    /// Performs constant-time verification against candidate input.
    /// Resists timing-attack side channels.
    pub fn verify(&self, candidate: &str) -> bool {
        let cleaned: String = candidate
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '-')
            .flat_map(|c| c.to_uppercase())
            .collect();

        if cleaned.len() != 8 {
            return false;
        }

        bool::from(self.raw.as_bytes().ct_eq(cleaned.as_bytes()))
    }

    /// Derives a 32-byte shared pairing key from this code and a 32-byte salt.
    pub fn derive_key(&self, salt: &[u8]) -> Result<[u8; 32], PairingError> {
        derive_pairing_code_key(&self.raw, salt)
            .map_err(|e| PairingError::CryptoError(e.to_string()))
    }
}

// ---------------------------------------------------------------------------
// Phone Number Normalization
// ---------------------------------------------------------------------------

/// Normalizes an international phone number (E.164 digits format, 7 to 15 digits).
pub fn normalize_phone_number(input: &str) -> Result<String, PairingError> {
    let digits: String = input.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() < 7 || digits.len() > 15 {
        return Err(PairingError::InvalidPhoneNumber(format!(
            "Phone number must have between 7 and 15 digits, got {} ('{}')",
            digits.len(),
            input
        )));
    }
    Ok(digits)
}

// ---------------------------------------------------------------------------
// Pairing Code Session
// ---------------------------------------------------------------------------

/// Active mobile pairing code session tracking attempts, salt, and expiry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairingCodeSession {
    /// Normalized phone number.
    pub phone_number: String,
    /// Generated pairing code.
    pub pairing_code: PairingCode,
    /// 32-byte cryptographic salt.
    pub salt: [u8; 32],
    /// Unix timestamp when created.
    pub created_at: u64,
    /// Unix timestamp when code expires.
    pub expires_at: u64,
    /// Verification attempt counter.
    pub attempts: u32,
    /// Maximum verification attempts allowed before lockout.
    pub max_attempts: u32,
    /// Whether this session was successfully verified.
    pub is_verified: bool,
}

impl PairingCodeSession {
    /// Creates a new pairing session with numeric 8-digit code.
    pub fn new(phone_number: &str, ttl_seconds: u64, now: u64) -> Result<Self, PairingError> {
        let phone = normalize_phone_number(phone_number)?;
        let code = PairingCode::generate_numeric();
        let mut salt = [0u8; 32];
        rand::rng().fill_bytes(&mut salt);

        Ok(Self {
            phone_number: phone,
            pairing_code: code,
            salt,
            created_at: now,
            expires_at: now.saturating_add(ttl_seconds),
            attempts: 0,
            max_attempts: DEFAULT_MAX_VERIFICATION_ATTEMPTS,
            is_verified: false,
        })
    }

    /// Creates a new pairing session with alphanumeric 8-character code.
    pub fn new_alphanumeric(
        phone_number: &str,
        ttl_seconds: u64,
        now: u64,
    ) -> Result<Self, PairingError> {
        let phone = normalize_phone_number(phone_number)?;
        let code = PairingCode::generate_alphanumeric();
        let mut salt = [0u8; 32];
        rand::rng().fill_bytes(&mut salt);

        Ok(Self {
            phone_number: phone,
            pairing_code: code,
            salt,
            created_at: now,
            expires_at: now.saturating_add(ttl_seconds),
            attempts: 0,
            max_attempts: DEFAULT_MAX_VERIFICATION_ATTEMPTS,
            is_verified: false,
        })
    }

    /// Checks if the session has expired at `now`.
    pub fn is_expired(&self, now: u64) -> bool {
        now >= self.expires_at
    }

    /// Remaining verification attempts.
    pub fn remaining_attempts(&self) -> u32 {
        self.max_attempts.saturating_sub(self.attempts)
    }

    /// Remaining seconds before expiration.
    pub fn time_to_live(&self, now: u64) -> u64 {
        self.expires_at.saturating_sub(now)
    }

    /// Verifies candidate code.
    /// Enforces expiry check, rate limiting, and constant-time equality check.
    pub fn verify(&mut self, candidate: &str, now: u64) -> Result<bool, PairingError> {
        if self.is_expired(now) {
            return Err(PairingError::Expired {
                expired_at: self.expires_at,
                now,
            });
        }

        if self.attempts >= self.max_attempts {
            return Err(PairingError::MaxAttemptsExceeded {
                max: self.max_attempts,
            });
        }

        self.attempts += 1;
        let matched = self.pairing_code.verify(candidate);
        if matched {
            self.is_verified = true;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Derives the 32-byte pairing key using the session's code and salt.
    pub fn derive_key(&self) -> Result<[u8; 32], PairingError> {
        self.pairing_code.derive_key(&self.salt)
    }
}

// ---------------------------------------------------------------------------
// Companion Device Registration State Machine
// ---------------------------------------------------------------------------

/// Method used to initiate companion pairing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum PairingMethod {
    QrCode,
    PairingCode,
}

/// State of the companion device registration process.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RegistrationState {
    /// Idle / uninitialized state.
    Idle,

    /// Waiting for companion device to scan the active QR code.
    AwaitingQrScan {
        ref_id: String,
        qr_payload: String,
        noise_key: [u8; 32],
        identity_key: [u8; 32],
        adv_secret: Option<[u8; 32]>,
        created_at: u64,
        expires_at: u64,
        refresh_count: u32,
    },

    /// Waiting for user/phone to confirm the 8-digit mobile pairing code.
    AwaitingPairingCode {
        session: PairingCodeSession,
        noise_key: [u8; 32],
        identity_key: [u8; 32],
    },

    /// QR scanned or pairing code verified; executing Noise XX cryptographic handshake.
    Handshaking {
        method: PairingMethod,
        client_ephemeral: [u8; 32],
        started_at: u64,
    },

    /// Noise handshake completed; companion device registration stanza pending ack.
    Registering {
        client_static_pub: [u8; 32],
        companion_jid: Option<String>,
        started_at: u64,
    },

    /// Pairing and companion registration succeeded.
    Paired {
        companion_jid: String,
        lid: Option<String>,
        device_id: u32,
        paired_at: u64,
    },

    /// Registration timed out.
    Expired {
        expired_at: u64,
        previous_state: String,
    },

    /// Registration failed or rejected.
    Failed {
        reason: String,
        failed_at: u64,
    },
}

/// High-level companion device registration state machine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompanionRegistrationStateMachine {
    state: RegistrationState,
}

impl CompanionRegistrationStateMachine {
    /// Creates a new state machine in `Idle` state.
    pub fn new() -> Self {
        Self {
            state: RegistrationState::Idle,
        }
    }

    /// Returns the current state.
    pub fn state(&self) -> &RegistrationState {
        &self.state
    }

    /// Checks if currently in `Idle` state.
    pub fn is_idle(&self) -> bool {
        matches!(self.state, RegistrationState::Idle)
    }

    /// Checks if currently waiting for a QR scan.
    pub fn is_awaiting_qr(&self) -> bool {
        matches!(self.state, RegistrationState::AwaitingQrScan { .. })
    }

    /// Checks if currently waiting for pairing code verification.
    pub fn is_awaiting_code(&self) -> bool {
        matches!(self.state, RegistrationState::AwaitingPairingCode { .. })
    }

    /// Checks if actively in handshake or registration.
    pub fn is_in_progress(&self) -> bool {
        matches!(
            self.state,
            RegistrationState::Handshaking { .. } | RegistrationState::Registering { .. }
        )
    }

    /// Checks if companion is fully paired and authenticated.
    pub fn is_paired(&self) -> bool {
        matches!(self.state, RegistrationState::Paired { .. })
    }

    /// Checks if the state machine is in a terminal state (Paired, Expired, or Failed).
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.state,
            RegistrationState::Paired { .. }
                | RegistrationState::Expired { .. }
                | RegistrationState::Failed { .. }
        )
    }

    /// Initiates QR code pairing mode.
    pub fn start_qr(
        &mut self,
        ref_id: String,
        noise_key: [u8; 32],
        identity_key: [u8; 32],
        adv_secret: Option<[u8; 32]>,
        ttl_seconds: u64,
        now: u64,
    ) -> Result<QrPairingPayload, PairingError> {
        let payload = QrPairingPayload::new(
            ref_id.clone(),
            noise_key,
            identity_key,
            adv_secret,
        );
        let qr_string = payload.to_qr_string();

        self.state = RegistrationState::AwaitingQrScan {
            ref_id,
            qr_payload: qr_string,
            noise_key,
            identity_key,
            adv_secret,
            created_at: now,
            expires_at: now.saturating_add(ttl_seconds),
            refresh_count: 0,
        };

        Ok(payload)
    }

    /// Refreshes the QR code with a new server reference token without losing keys.
    pub fn refresh_qr(
        &mut self,
        new_ref_id: String,
        ttl_seconds: u64,
        now: u64,
    ) -> Result<QrPairingPayload, PairingError> {
        match &self.state {
            RegistrationState::AwaitingQrScan {
                noise_key,
                identity_key,
                adv_secret,
                refresh_count,
                ..
            } => {
                let payload = QrPairingPayload::new(
                    new_ref_id.clone(),
                    *noise_key,
                    *identity_key,
                    *adv_secret,
                );
                let qr_string = payload.to_qr_string();

                self.state = RegistrationState::AwaitingQrScan {
                    ref_id: new_ref_id,
                    qr_payload: qr_string,
                    noise_key: *noise_key,
                    identity_key: *identity_key,
                    adv_secret: *adv_secret,
                    created_at: now,
                    expires_at: now.saturating_add(ttl_seconds),
                    refresh_count: refresh_count.saturating_add(1),
                };

                Ok(payload)
            }
            other => Err(PairingError::InvalidStateTransition {
                from: format!("{other:?}"),
                event: "refresh_qr".to_string(),
            }),
        }
    }

    /// Initiates 8-digit mobile pairing code mode.
    pub fn start_pairing_code(
        &mut self,
        phone_number: &str,
        noise_key: [u8; 32],
        identity_key: [u8; 32],
        ttl_seconds: u64,
        now: u64,
    ) -> Result<PairingCode, PairingError> {
        let session = PairingCodeSession::new(phone_number, ttl_seconds, now)?;
        let code = session.pairing_code.clone();

        self.state = RegistrationState::AwaitingPairingCode {
            session,
            noise_key,
            identity_key,
        };

        Ok(code)
    }

    /// Verifies candidate pairing code against active session.
    /// If valid, transitions to `Handshaking`.
    pub fn verify_pairing_code(&mut self, candidate: &str, now: u64) -> Result<bool, PairingError> {
        match &mut self.state {
            RegistrationState::AwaitingPairingCode {
                session,
                ..
            } => {
                let matched = session.verify(candidate, now)?;
                if matched {
                    // Transition to Handshaking state
                    let client_ephemeral = [0u8; 32];
                    self.state = RegistrationState::Handshaking {
                        method: PairingMethod::PairingCode,
                        client_ephemeral,
                        started_at: now,
                    };
                    Ok(true)
                } else {
                    Ok(false)
                }
            }
            other => Err(PairingError::InvalidStateTransition {
                from: format!("{other:?}"),
                event: "verify_pairing_code".to_string(),
            }),
        }
    }

    /// Companion device scanned QR code and sent client ephemeral public key.
    pub fn on_qr_scanned(
        &mut self,
        client_ephemeral: [u8; 32],
        now: u64,
    ) -> Result<(), PairingError> {
        let is_expired = match &self.state {
            RegistrationState::AwaitingQrScan { expires_at, .. } => {
                if now >= *expires_at {
                    Some(*expires_at)
                } else {
                    None
                }
            }
            _ => None,
        };

        if let Some(expired_at) = is_expired {
            self.state = RegistrationState::Expired {
                expired_at,
                previous_state: "AwaitingQrScan".to_string(),
            };
            return Err(PairingError::Expired { expired_at, now });
        }

        match &self.state {
            RegistrationState::AwaitingQrScan { .. } => {
                self.state = RegistrationState::Handshaking {
                    method: PairingMethod::QrCode,
                    client_ephemeral,
                    started_at: now,
                };
                Ok(())
            }
            other => Err(PairingError::InvalidStateTransition {
                from: format!("{other:?}"),
                event: "on_qr_scanned".to_string(),
            }),
        }
    }

    /// Noise handshake completed; transitions to `Registering`.
    pub fn on_handshake_complete(
        &mut self,
        client_static_pub: [u8; 32],
        companion_jid: Option<String>,
        now: u64,
    ) -> Result<(), PairingError> {
        match &self.state {
            RegistrationState::Handshaking { .. } => {
                self.state = RegistrationState::Registering {
                    client_static_pub,
                    companion_jid,
                    started_at: now,
                };
                Ok(())
            }
            other => Err(PairingError::InvalidStateTransition {
                from: format!("{other:?}"),
                event: "on_handshake_complete".to_string(),
            }),
        }
    }

    /// Companion device successfully registered with WhatsApp servers.
    pub fn on_registration_success(
        &mut self,
        companion_jid: String,
        lid: Option<String>,
        device_id: u32,
        now: u64,
    ) -> Result<(), PairingError> {
        match &self.state {
            RegistrationState::Registering { .. } => {
                self.state = RegistrationState::Paired {
                    companion_jid,
                    lid,
                    device_id,
                    paired_at: now,
                };
                Ok(())
            }
            other => Err(PairingError::InvalidStateTransition {
                from: format!("{other:?}"),
                event: "on_registration_success".to_string(),
            }),
        }
    }

    /// Marks the registration as failed.
    pub fn fail(&mut self, reason: &str, now: u64) {
        self.state = RegistrationState::Failed {
            reason: reason.to_string(),
            failed_at: now,
        };
    }

    /// Cancels active pairing and returns to `Idle`.
    pub fn cancel(&mut self) {
        self.state = RegistrationState::Idle;
    }

    /// Resets the state machine back to `Idle`.
    pub fn reset(&mut self) {
        self.state = RegistrationState::Idle;
    }

    /// Checks if current pending session has expired; transitions to `Expired` if so.
    pub fn check_expiry(&mut self, now: u64) -> bool {
        let expiry_info = match &self.state {
            RegistrationState::AwaitingQrScan { expires_at, .. } if now >= *expires_at => {
                Some((*expires_at, "AwaitingQrScan".to_string()))
            }
            RegistrationState::AwaitingPairingCode { session, .. } if session.is_expired(now) => {
                Some((session.expires_at, "AwaitingPairingCode".to_string()))
            }
            _ => None,
        };

        if let Some((expired_at, previous_state)) = expiry_info {
            self.state = RegistrationState::Expired {
                expired_at,
                previous_state,
            };
            true
        } else {
            false
        }
    }

    /// Returns active QR payload string if in QR scanning state.
    pub fn current_qr_payload(&self) -> Option<&str> {
        match &self.state {
            RegistrationState::AwaitingQrScan { qr_payload, .. } => Some(qr_payload.as_str()),
            _ => None,
        }
    }

    /// Returns active pairing code if in pairing code state.
    pub fn current_pairing_code(&self) -> Option<&PairingCode> {
        match &self.state {
            RegistrationState::AwaitingPairingCode { session, .. } => Some(&session.pairing_code),
            _ => None,
        }
    }

    /// Returns pairing success information `(companion_jid, lid, device_id)` if paired.
    pub fn paired_info(&self) -> Option<(&str, Option<&str>, u32)> {
        match &self.state {
            RegistrationState::Paired {
                companion_jid,
                lid,
                device_id,
                ..
            } => Some((companion_jid.as_str(), lid.as_deref(), *device_id)),
            _ => None,
        }
    }
}

impl Default for CompanionRegistrationStateMachine {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Unit Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pairing_code_numeric_generation_and_format() {
        let code = PairingCode::generate_numeric();
        assert_eq!(code.raw().len(), 8);
        assert!(code.raw().chars().all(|c| c.is_ascii_digit()));

        let formatted = code.formatted();
        assert_eq!(formatted.len(), 9);
        assert_eq!(&formatted[4..5], "-");
    }

    #[test]
    fn test_pairing_code_alphanumeric_generation() {
        let code = PairingCode::generate_alphanumeric();
        assert_eq!(code.raw().len(), 8);
        assert!(code.raw().chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn test_pairing_code_constant_time_verification() {
        let code = PairingCode::new("48291053").unwrap();

        // Exact match
        assert!(code.verify("48291053"));
        // With hyphen
        assert!(code.verify("4829-1053"));
        // With spaces
        assert!(code.verify("4829 1053"));
        // Mismatch
        assert!(!code.verify("48291054"));
        // Wrong length
        assert!(!code.verify("4829"));
    }

    #[test]
    fn test_pairing_code_key_derivation() {
        let code = PairingCode::new("12345678").unwrap();
        let salt = [0x55u8; 32];
        let key = code.derive_key(&salt).unwrap();
        assert_ne!(key, [0u8; 32]);
    }

    #[test]
    fn test_phone_number_normalization() {
        assert_eq!(
            normalize_phone_number("+1 (555) 123-4567").unwrap(),
            "15551234567"
        );
        assert_eq!(
            normalize_phone_number("5511999998888").unwrap(),
            "5511999998888"
        );
        assert!(normalize_phone_number("123").is_err());
    }

    #[test]
    fn test_pairing_code_session_attempts_and_expiry() {
        let mut session =
            PairingCodeSession::new("+15551234567", 60, 1000).unwrap();
        assert_eq!(session.remaining_attempts(), 5);
        assert_eq!(session.time_to_live(1020), 40);

        // Wrong attempt
        let res = session.verify("00000000", 1010).unwrap();
        assert!(!res);
        assert_eq!(session.attempts, 1);
        assert_eq!(session.remaining_attempts(), 4);

        // Correct attempt
        let correct = session.pairing_code.raw().to_string();
        let res2 = session.verify(&correct, 1015).unwrap();
        assert!(res2);
        assert!(session.is_verified);

        // Expired attempt
        let err = session.verify(&correct, 1070);
        assert!(matches!(err, Err(PairingError::Expired { .. })));
    }

    #[test]
    fn test_qr_state_machine_happy_path() {
        let mut sm = CompanionRegistrationStateMachine::new();
        assert!(sm.is_idle());

        let noise_key = [0x11u8; 32];
        let id_key = [0x22u8; 32];
        let now = 1_000_000;

        // Start QR
        let payload = sm
            .start_qr(
                "ref_test_1".to_string(),
                noise_key,
                id_key,
                None,
                60,
                now,
            )
            .unwrap();
        assert!(sm.is_awaiting_qr());
        assert_eq!(payload.ref_id, "ref_test_1");

        // QR Refresh
        let refreshed = sm
            .refresh_qr("ref_test_2".to_string(), 60, now + 30)
            .unwrap();
        assert_eq!(refreshed.ref_id, "ref_test_2");

        // Companion Scans QR
        let client_ephemeral = [0x33u8; 32];
        sm.on_qr_scanned(client_ephemeral, now + 40).unwrap();
        assert!(matches!(
            sm.state(),
            RegistrationState::Handshaking { .. }
        ));

        // Handshake Complete
        let client_static = [0x44u8; 32];
        sm.on_handshake_complete(
            client_static,
            Some("15551234567@s.whatsapp.net".to_string()),
            now + 45,
        )
        .unwrap();
        assert!(matches!(
            sm.state(),
            RegistrationState::Registering { .. }
        ));

        // Registration Success
        sm.on_registration_success(
            "15551234567:1@s.whatsapp.net".to_string(),
            Some("15551234567@lid".to_string()),
            1,
            now + 50,
        )
        .unwrap();
        assert!(sm.is_paired());
        let (jid, lid, dev) = sm.paired_info().unwrap();
        assert_eq!(jid, "15551234567:1@s.whatsapp.net");
        assert_eq!(lid, Some("15551234567@lid"));
        assert_eq!(dev, 1);
    }

    #[test]
    fn test_pairing_code_state_machine_happy_path() {
        let mut sm = CompanionRegistrationStateMachine::new();
        let noise_key = [0xaa; 32];
        let id_key = [0xbb; 32];
        let now = 5000;

        // Start pairing code
        let code = sm
            .start_pairing_code("+15559876543", noise_key, id_key, 160, now)
            .unwrap();
        assert!(sm.is_awaiting_code());

        // Verify valid code
        let ok = sm.verify_pairing_code(&code.formatted(), now + 10).unwrap();
        assert!(ok);
        assert!(matches!(
            sm.state(),
            RegistrationState::Handshaking { .. }
        ));

        // Complete handshake and registration
        sm.on_handshake_complete([0xcc; 32], None, now + 15).unwrap();
        sm.on_registration_success(
            "15559876543:0@s.whatsapp.net".to_string(),
            None,
            0,
            now + 20,
        )
        .unwrap();
        assert!(sm.is_paired());
    }

    #[test]
    fn test_state_machine_expiry_check() {
        let mut sm = CompanionRegistrationStateMachine::new();
        sm.start_qr(
            "ref_exp".to_string(),
            [0; 32],
            [0; 32],
            None,
            60,
            100,
        )
        .unwrap();

        assert!(!sm.check_expiry(150));
        assert!(sm.check_expiry(160));
        assert!(matches!(sm.state(), RegistrationState::Expired { .. }));
    }
}
