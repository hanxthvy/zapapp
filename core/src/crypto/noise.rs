// [xihanzu-NR]

use crate::crypto::cipher::{
    aes_256_gcm_decrypt, aes_256_gcm_encrypt, generate_iv, hkdf_expand_64, sha256,
};
use crate::crypto::curve::{calculate_agreement, verify, KeyPair};
use crate::crypto::CryptoError;

pub const NOISE_MODE: &[u8; 32] = b"Noise_XX_25519_AESGCM_SHA256\0\0\0\0";
pub const NOISE_WA_HEADER: [u8; 4] = [87, 65, 6, 3]; // 'W', 'A', 6, 3
pub const WA_CERT_SERIAL: u32 = 0;
pub const WA_CERT_ISSUER: &str = "WhatsAppLongTerm1";
pub const WA_CERT_PUBLIC_KEY: [u8; 32] = [
    0x14, 0x23, 0x75, 0x57, 0x4d, 0x0a, 0x58, 0x71, 0x66, 0xaa, 0xe7, 0x1e, 0xbe, 0x51, 0x64,
    0x37, 0xc4, 0xa2, 0x8b, 0x73, 0xe3, 0x69, 0x5c, 0x6c, 0xe1, 0xf7, 0xf9, 0x54, 0x5d, 0xa8,
    0xee, 0x6b,
];

#[derive(Clone, Debug)]
pub struct TransportState {
    pub enc_key: [u8; 32],
    pub dec_key: [u8; 32],
    pub write_counter: u32,
    pub read_counter: u32,
}

impl TransportState {
    pub fn new(enc_key: [u8; 32], dec_key: [u8; 32]) -> Self {
        Self {
            enc_key,
            dec_key,
            write_counter: 0,
            read_counter: 0,
        }
    }

    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
        let iv = generate_iv(self.write_counter);
        self.write_counter = self
            .write_counter
            .checked_add(1)
            .ok_or_else(|| CryptoError::ProtocolError("Write counter overflow".into()))?;
        aes_256_gcm_encrypt(plaintext, &self.enc_key, &iv, b"")
    }

    pub fn decrypt(&mut self, ciphertext: &[u8]) -> Result<Vec<u8>, CryptoError> {
        let iv = generate_iv(self.read_counter);
        self.read_counter = self
            .read_counter
            .checked_add(1)
            .ok_or_else(|| CryptoError::ProtocolError("Read counter overflow".into()))?;
        aes_256_gcm_decrypt(ciphertext, &self.dec_key, &iv, b"")
    }
}

#[derive(Clone, Debug)]
pub struct ServerHelloDecrypted {
    pub server_static: [u8; 32],
    pub server_payload: Vec<u8>,
    pub client_static_enc: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct HandshakeState {
    pub hash: [u8; 32],
    pub salt: [u8; 32],
    pub enc_key: [u8; 32],
    pub dec_key: [u8; 32],
    pub counter: u32,
    pub ephemeral_key: KeyPair,
    pub sent_intro: bool,
    pub intro_header: Vec<u8>,
    pub transport: Option<TransportState>,
}

impl HandshakeState {
    pub fn new(
        ephemeral_key: KeyPair,
        noise_header: Option<&[u8]>,
        routing_info: Option<&[u8]>,
    ) -> Self {
        let header = noise_header.unwrap_or(&NOISE_WA_HEADER);
        let intro_header = if let Some(routing) = routing_info {
            let rlen = routing.len();
            let mut buf = Vec::with_capacity(7 + rlen + header.len());
            buf.extend_from_slice(b"ED");
            buf.push(0);
            buf.push(1);
            buf.push((rlen >> 16) as u8);
            buf.push((rlen >> 8) as u8);
            buf.push((rlen & 0xff) as u8);
            buf.extend_from_slice(routing);
            buf.extend_from_slice(header);
            buf
        } else {
            header.to_vec()
        };

        let hash = *NOISE_MODE;
        let salt = hash;
        let enc_key = hash;
        let dec_key = hash;

        let mut state = Self {
            hash,
            salt,
            enc_key,
            dec_key,
            counter: 0,
            ephemeral_key,
            sent_intro: false,
            intro_header,
            transport: None,
        };

        state.authenticate(header);
        let epk = state.ephemeral_key.public;
        state.authenticate(&epk);
        state
    }

    pub fn authenticate(&mut self, data: &[u8]) {
        if self.transport.is_none() {
            let mut combined = Vec::with_capacity(self.hash.len() + data.len());
            combined.extend_from_slice(&self.hash);
            combined.extend_from_slice(data);
            self.hash = sha256(&combined);
        }
    }

    pub fn mix_into_key(&mut self, dh_secret: &[u8]) -> Result<(), CryptoError> {
        let (write, read) = hkdf_expand_64(&self.salt, dh_secret)?;
        self.salt = write;
        self.enc_key = read;
        self.dec_key = read;
        self.counter = 0;
        Ok(())
    }

    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
        if let Some(ref mut transport) = self.transport {
            return transport.encrypt(plaintext);
        }
        let iv = generate_iv(self.counter);
        self.counter = self
            .counter
            .checked_add(1)
            .ok_or_else(|| CryptoError::ProtocolError("Counter overflow".into()))?;
        let result = aes_256_gcm_encrypt(plaintext, &self.enc_key, &iv, &self.hash)?;
        self.authenticate(&result);
        Ok(result)
    }

    pub fn decrypt(&mut self, ciphertext: &[u8]) -> Result<Vec<u8>, CryptoError> {
        if let Some(ref mut transport) = self.transport {
            return transport.decrypt(ciphertext);
        }
        let iv = generate_iv(self.counter);
        self.counter = self
            .counter
            .checked_add(1)
            .ok_or_else(|| CryptoError::ProtocolError("Counter overflow".into()))?;
        let result = aes_256_gcm_decrypt(ciphertext, &self.dec_key, &iv, &self.hash)?;
        self.authenticate(ciphertext);
        Ok(result)
    }

    pub fn build_client_hello(&self) -> [u8; 32] {
        self.ephemeral_key.public
    }

    pub fn process_server_hello(
        &mut self,
        server_ephemeral: &[u8; 32],
        server_static_enc: &[u8],
        server_payload_enc: &[u8],
        client_static: &KeyPair,
    ) -> Result<ServerHelloDecrypted, CryptoError> {
        // 1. Authenticate server ephemeral
        self.authenticate(server_ephemeral);

        // 2. DH(e_c, e_s)
        let dh1 = calculate_agreement(&self.ephemeral_key.private, server_ephemeral)?;
        self.mix_into_key(&dh1)?;

        // 3. Decrypt server static key
        let server_static_bytes = self.decrypt(server_static_enc)?;
        if server_static_bytes.len() != 32 {
            return Err(CryptoError::NoiseHandshakeError(
                "Decrypted server static key must be 32 bytes".to_string(),
            ));
        }
        let mut server_static = [0u8; 32];
        server_static.copy_from_slice(&server_static_bytes);

        // 4. DH(e_c, s_s)
        let dh2 = calculate_agreement(&self.ephemeral_key.private, &server_static)?;
        self.mix_into_key(&dh2)?;

        // 5. Decrypt server payload
        let server_payload = self.decrypt(server_payload_enc)?;

        // 6. Encrypt client static key
        let client_static_enc = self.encrypt(&client_static.public)?;

        // 7. DH(s_c, e_s)
        let dh3 = calculate_agreement(&client_static.private, server_ephemeral)?;
        self.mix_into_key(&dh3)?;

        Ok(ServerHelloDecrypted {
            server_static,
            server_payload,
            client_static_enc,
        })
    }

    pub fn build_client_finish(&mut self, client_payload: &[u8]) -> Result<Vec<u8>, CryptoError> {
        self.encrypt(client_payload)
    }

    pub fn finish_init(&mut self) -> Result<(), CryptoError> {
        let (write, read) = hkdf_expand_64(&self.salt, b"")?;
        self.transport = Some(TransportState::new(write, read));
        Ok(())
    }

    pub fn is_transport_active(&self) -> bool {
        self.transport.is_some()
    }

    pub fn transport(&self) -> Option<&TransportState> {
        self.transport.as_ref()
    }

    pub fn transport_mut(&mut self) -> Option<&mut TransportState> {
        self.transport.as_mut()
    }

    pub fn encode_frame(&mut self, data: &[u8]) -> Result<Vec<u8>, CryptoError> {
        let payload = if let Some(ref mut transport) = self.transport {
            transport.encrypt(data)?
        } else {
            data.to_vec()
        };

        let data_len = payload.len();
        let intro_size = if self.sent_intro {
            0
        } else {
            self.intro_header.len()
        };

        let mut frame = Vec::with_capacity(intro_size + 3 + data_len);
        if !self.sent_intro {
            frame.extend_from_slice(&self.intro_header);
            self.sent_intro = true;
        }
        frame.push(((data_len >> 16) & 0xff) as u8);
        frame.push(((data_len >> 8) & 0xff) as u8);
        frame.push((data_len & 0xff) as u8);
        frame.extend_from_slice(&payload);
        Ok(frame)
    }

    pub fn decode_frames(&mut self, buffer: &mut Vec<u8>) -> Result<Vec<Vec<u8>>, CryptoError> {
        let mut frames = Vec::new();
        loop {
            if buffer.len() < 3 {
                break;
            }
            let size =
                ((buffer[0] as usize) << 16) | ((buffer[1] as usize) << 8) | (buffer[2] as usize);
            if buffer.len() < size + 3 {
                break;
            }
            let frame_data = buffer[3..size + 3].to_vec();
            buffer.drain(0..size + 3);

            let decrypted = if let Some(ref mut transport) = self.transport {
                transport.decrypt(&frame_data)?
            } else {
                frame_data
            };
            frames.push(decrypted);
        }
        Ok(frames)
    }
}

pub fn verify_noise_certificate(
    issuer_pub_key: &[u8],
    cert_details: &[u8],
    signature: &[u8; 64],
) -> bool {
    verify(issuer_pub_key, cert_details, signature)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::curve::generate_key_pair;

    #[test]
    fn test_transport_encrypt_decrypt() {
        let enc_key = [0x11u8; 32];
        let dec_key = [0x22u8; 32];

        // Sender uses enc_key, receiver uses enc_key as dec_key
        let mut sender = TransportState::new(enc_key, dec_key);
        let mut receiver = TransportState::new(dec_key, enc_key);

        let msg = b"Testing WhatsApp transport stream encryption";
        let ciphertext = sender.encrypt(msg).unwrap();
        let decrypted = receiver.decrypt(&ciphertext).unwrap();
        assert_eq!(&decrypted[..], msg);
    }

    #[test]
    fn test_frame_encoding_and_decoding() {
        let kp = generate_key_pair();
        let mut client = HandshakeState::new(kp, None, None);
        client.finish_init().unwrap();

        let transport_enc_key = client.transport().unwrap().enc_key;
        let transport_dec_key = client.transport().unwrap().dec_key;

        // Peer receives with inverted keys
        let mut peer_transport = TransportState::new(transport_dec_key, transport_enc_key);

        let data = b"<iq id='1'/>";
        let mut framed = client.encode_frame(data).unwrap();

        // Intro header was prepended on first frame
        assert!(framed.starts_with(&NOISE_WA_HEADER));
        framed.drain(0..NOISE_WA_HEADER.len());

        let peer_buf = framed;
        let size = ((peer_buf[0] as usize) << 16)
            | ((peer_buf[1] as usize) << 8)
            | (peer_buf[2] as usize);
        let cipher_payload = &peer_buf[3..3 + size];
        let plain = peer_transport.decrypt(cipher_payload).unwrap();
        assert_eq!(&plain[..], data);
    }

    #[test]
    fn test_noise_handshake_flow() {
        let client_e = generate_key_pair();
        let client_s = generate_key_pair();

        let server_e = generate_key_pair();
        let server_s = generate_key_pair();

        let mut client_noise = HandshakeState::new(client_e.clone(), None, None);

        // Server side wire simulation
        let mut s_hash = *NOISE_MODE;
        let mut s_salt = s_hash;
        // Authenticate header
        s_hash = sha256(&[&s_hash[..], &NOISE_WA_HEADER[..]].concat());
        // Authenticate client ephemeral
        s_hash = sha256(&[&s_hash[..], &client_e.public[..]].concat());
        // Authenticate server ephemeral
        s_hash = sha256(&[&s_hash[..], &server_e.public[..]].concat());

        // DH(server_e, client_e)
        let s_dh1 = calculate_agreement(&server_e.private, &client_e.public).unwrap();
        let (sw, sr) = hkdf_expand_64(&s_salt, &s_dh1).unwrap();
        s_salt = sw;
        let s_enc = sr;
        let mut s_counter = 0;

        // Encrypt server_s
        let iv1 = generate_iv(s_counter);
        let s_static_enc = aes_256_gcm_encrypt(&server_s.public, &s_enc, &iv1, &s_hash).unwrap();
        s_hash = sha256(&[&s_hash[..], &s_static_enc[..]].concat());

        // DH(server_s, client_e)
        let s_dh2 = calculate_agreement(&server_s.private, &client_e.public).unwrap();
        let (sw, sr) = hkdf_expand_64(&s_salt, &s_dh2).unwrap();
        s_salt = sw;
        let s_enc = sr;
        let mut s_dec = sr;
        s_counter = 0;

        // Encrypt server payload
        let iv2 = generate_iv(s_counter);
        s_counter += 1;
        let server_payload = b"SERVER_PAYLOAD";
        let s_payload_enc = aes_256_gcm_encrypt(server_payload, &s_enc, &iv2, &s_hash).unwrap();
        s_hash = sha256(&[&s_hash[..], &s_payload_enc[..]].concat());

        // Client processes ServerHello
        let s_hello_dec = client_noise
            .process_server_hello(
                &server_e.public,
                &s_static_enc,
                &s_payload_enc,
                &client_s,
            )
            .unwrap();
        assert_eq!(s_hello_dec.server_static, server_s.public);
        assert_eq!(s_hello_dec.server_payload, server_payload);

        // Client builds ClientFinish
        let client_payload = b"<login user='12345'/>";
        let c_payload_enc = client_noise.build_client_finish(client_payload).unwrap();

        // Server decrypts ClientFinish
        let iv3 = generate_iv(s_counter);
        let s_dec_client_static =
            aes_256_gcm_decrypt(&s_hello_dec.client_static_enc, &s_dec, &iv3, &s_hash).unwrap();
        assert_eq!(&s_dec_client_static[..], &client_s.public[..]);
        s_hash = sha256(&[&s_hash[..], &s_hello_dec.client_static_enc[..]].concat());

        // DH(client_s, server_e)
        let s_dh3 = calculate_agreement(&server_e.private, &client_s.public).unwrap();
        let (sw, sr) = hkdf_expand_64(&s_salt, &s_dh3).unwrap();
        s_dec = sr;
        s_counter = 0;

        let iv4 = generate_iv(s_counter);
        let s_dec_client_payload =
            aes_256_gcm_decrypt(&c_payload_enc, &s_dec, &iv4, &s_hash).unwrap();
        assert_eq!(&s_dec_client_payload[..], client_payload);

        // Transition to transport state
        client_noise.finish_init().unwrap();
        assert!(client_noise.is_transport_active());

        let (s_write, s_read) = hkdf_expand_64(&sw, b"").unwrap();
        let mut server_transport = TransportState::new(s_read, s_write);

        let ping = b"<ping/>";
        let client_transport = client_noise.transport_mut().unwrap();
        let enc_ping = client_transport.encrypt(ping).unwrap();
        let dec_ping = server_transport.decrypt(&enc_ping).unwrap();
        assert_eq!(&dec_ping[..], ping);
    }
}
