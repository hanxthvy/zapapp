// [xihanzu-NR]
//! WhatsApp WebSocket Stream with Noise XX Handshake Framing.
//! Wraps tokio-tungstenite WebSocket connection and handles Noise protocol framing,
//! length prefixes (3-byte big-endian), transport cipher transitions, and binary XML node IO.

use std::collections::VecDeque;

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use crate::crypto::curve::KeyPair;
use crate::crypto::noise::{HandshakeState, NOISE_WA_HEADER};
use crate::network::{NetworkConfig, NetworkError};
use crate::proto::node::BinaryNode;

pub const WA_WS_URL: &str = "wss://web.whatsapp.com/ws/chat";
pub const WA_ORIGIN: &str = "https://web.whatsapp.com";
pub const WA_USER_AGENT: &str =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// Result of a completed Noise XX handshake with WhatsApp server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HandshakeResult {
    /// Server static Curve25519 public key.
    pub server_static: [u8; 32],
    /// Decrypted server payload (certificates, signed tokens, etc.).
    pub server_payload: Vec<u8>,
}

/// Operational state of the WhatsApp stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamState {
    /// Connected, handshake pending.
    Handshaking,
    /// Handshake completed, transport cipher active.
    TransportActive,
    /// Stream is closed or shutting down.
    Closed,
}

/// WhatsApp framed WebSocket stream.
/// Generic over underlying transport `S` (TCP TLS stream or mock stream for tests).
pub struct WhatsAppStream<S> {
    ws_stream: WebSocketStream<S>,
    handshake: HandshakeState,
    recv_buffer: Vec<u8>,
    pending_frames: VecDeque<Vec<u8>>,
    state: StreamState,
}

/// Type alias for `WhatsAppStream` as `NoiseStream`.
pub type NoiseStream<S> = WhatsAppStream<S>;

/// Default stream type using tokio-tungstenite TLS over TCP.
pub type DefaultWhatsAppStream =
    WhatsAppStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

impl DefaultWhatsAppStream {
    /// Connect to WhatsApp WebSocket endpoint using the provided network configuration.
    pub async fn connect(
        config: &NetworkConfig,
        client_ephemeral: KeyPair,
        noise_header: Option<&[u8]>,
        routing_info: Option<&[u8]>,
    ) -> Result<Self, NetworkError> {
        let mut request = config
            .ws_url
            .clone()
            .into_client_request()
            .map_err(|e| NetworkError::Configuration(format!("Failed to build request: {e}")))?;

        request.headers_mut().insert(
            "Origin",
            HeaderValue::from_str(&config.origin)
                .map_err(|e| NetworkError::Configuration(format!("Invalid Origin: {e}")))?,
        );
        request.headers_mut().insert(
            "User-Agent",
            HeaderValue::from_str(&config.user_agent)
                .map_err(|e| NetworkError::Configuration(format!("Invalid User-Agent: {e}")))?,
        );

        let connect_fut = tokio_tungstenite::connect_async(request);
        let (ws_stream, _response) =
            tokio::time::timeout(config.connect_timeout, connect_fut)
                .await
                .map_err(|_| {
                    NetworkError::Configuration("Connection attempt timed out".into())
                })??;

        let handshake = HandshakeState::new(
            client_ephemeral,
            noise_header.or(Some(&NOISE_WA_HEADER)),
            routing_info,
        );

        Ok(Self {
            ws_stream,
            handshake,
            recv_buffer: Vec::with_capacity(4096),
            pending_frames: VecDeque::new(),
            state: StreamState::Handshaking,
        })
    }
}

impl<S> WhatsAppStream<S>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    /// Construct a WhatsApp stream from an existing WebSocket stream and HandshakeState.
    pub fn from_raw_ws(ws_stream: WebSocketStream<S>, handshake: HandshakeState) -> Self {
        let state = if handshake.is_transport_active() {
            StreamState::TransportActive
        } else {
            StreamState::Handshaking
        };

        Self {
            ws_stream,
            handshake,
            recv_buffer: Vec::with_capacity(4096),
            pending_frames: VecDeque::new(),
            state,
        }
    }

    /// Current operational state of the stream.
    pub fn state(&self) -> StreamState {
        self.state
    }

    /// Whether transport-level AES-GCM encryption is active.
    pub fn is_transport_active(&self) -> bool {
        self.handshake.is_transport_active()
    }

    /// Access reference to the internal HandshakeState.
    pub fn handshake_state(&self) -> &HandshakeState {
        &self.handshake
    }

    /// Execute the full 3-step Noise XX handshake:
    /// 1. Send ClientHello (intro header + 3-byte len + client ephemeral key).
    /// 2. Receive ServerHello (server ephemeral + encrypted server static + encrypted server payload).
    /// 3. Send ClientFinish (encrypted client static + encrypted client payload) and transition to Transport state.
    pub async fn handshake(
        &mut self,
        client_static: &KeyPair,
        client_payload: &[u8],
    ) -> Result<HandshakeResult, NetworkError> {
        // Step 1: Send ClientHello
        let client_hello = self.handshake.build_client_hello();
        let hello_frame = self.handshake.encode_frame(&client_hello)?;
        self.ws_stream.send(Message::Binary(hello_frame.into())).await?;

        // Step 2: Receive ServerHello frame
        let server_hello_raw = self.read_frame().await?.ok_or_else(|| {
            NetworkError::Handshake("Connection closed by server during handshake".into())
        })?;

        if server_hello_raw.len() < 80 {
            return Err(NetworkError::Handshake(format!(
                "Server hello frame too short: {} bytes (required >= 80)",
                server_hello_raw.len()
            )));
        }

        let mut server_ephemeral = [0u8; 32];
        server_ephemeral.copy_from_slice(&server_hello_raw[0..32]);
        let server_static_enc = &server_hello_raw[32..80];
        let server_payload_enc = &server_hello_raw[80..];

        let s_hello_dec = self.handshake.process_server_hello(
            &server_ephemeral,
            server_static_enc,
            server_payload_enc,
            client_static,
        )?;

        // Step 3: Build & Send ClientFinish frame
        let c_payload_enc = self.handshake.build_client_finish(client_payload)?;
        let mut finish_body =
            Vec::with_capacity(s_hello_dec.client_static_enc.len() + c_payload_enc.len());
        finish_body.extend_from_slice(&s_hello_dec.client_static_enc);
        finish_body.extend_from_slice(&c_payload_enc);

        let finish_frame = self.handshake.encode_frame(&finish_body)?;
        self.ws_stream.send(Message::Binary(finish_frame.into())).await?;

        // Transition HandshakeState to TransportState
        self.handshake.finish_init()?;
        self.state = StreamState::TransportActive;

        Ok(HandshakeResult {
            server_static: s_hello_dec.server_static,
            server_payload: s_hello_dec.server_payload,
        })
    }

    /// Send a framed (and encrypted if transport active) data payload.
    pub async fn send_frame(&mut self, data: &[u8]) -> Result<(), NetworkError> {
        if self.state == StreamState::Closed {
            return Err(NetworkError::ConnectionClosed);
        }
        let frame = self.handshake.encode_frame(data)?;
        self.ws_stream.send(Message::Binary(frame.into())).await?;
        Ok(())
    }

    /// Read next decrypted payload frame from WebSocket stream.
    /// Handles WebSocket Pings automatically, aggregates fragments, and drains decoded frames.
    pub async fn read_frame(&mut self) -> Result<Option<Vec<u8>>, NetworkError> {
        if let Some(frame) = self.pending_frames.pop_front() {
            return Ok(Some(frame));
        }

        if self.state == StreamState::Closed {
            return Ok(None);
        }

        loop {
            match self.ws_stream.next().await {
                Some(Ok(Message::Binary(bytes))) => {
                    self.recv_buffer.extend_from_slice(&bytes);
                    let decoded = self.handshake.decode_frames(&mut self.recv_buffer)?;
                    for frame in decoded {
                        self.pending_frames.push_back(frame);
                    }
                    if let Some(frame) = self.pending_frames.pop_front() {
                        return Ok(Some(frame));
                    }
                }
                Some(Ok(Message::Ping(payload))) => {
                    self.ws_stream.send(Message::Pong(payload)).await?;
                }
                Some(Ok(Message::Pong(_))) => {
                    // WebSocket-level pong
                }
                Some(Ok(Message::Close(_))) => {
                    self.state = StreamState::Closed;
                    return Ok(None);
                }
                Some(Ok(Message::Text(_))) => {
                    // WhatsApp protocol operates exclusively over binary frames
                }
                Some(Ok(Message::Frame(_))) => {}
                Some(Err(e)) => {
                    self.state = StreamState::Closed;
                    return Err(NetworkError::WebSocket(e));
                }
                None => {
                    self.state = StreamState::Closed;
                    return Ok(None);
                }
            }
        }
    }

    /// Serialize and send a `BinaryNode` stanza over the encrypted transport.
    pub async fn send_node(&mut self, node: &BinaryNode) -> Result<(), NetworkError> {
        let stanza_bytes = node.encode_stanza();
        self.send_frame(&stanza_bytes).await
    }

    /// Read next decrypted frame and parse it into a `BinaryNode`.
    pub async fn read_node(&mut self) -> Result<Option<BinaryNode>, NetworkError> {
        match self.read_frame().await? {
            Some(frame) => {
                let node = BinaryNode::decode_stanza(&frame)?;
                Ok(Some(node))
            }
            None => Ok(None),
        }
    }

    /// Send a WebSocket Ping frame.
    pub async fn send_ws_ping(&mut self, payload: Vec<u8>) -> Result<(), NetworkError> {
        self.ws_stream.send(Message::Ping(payload.into())).await?;
        Ok(())
    }

    /// Close the WebSocket stream cleanly.
    pub async fn close(&mut self) -> Result<(), NetworkError> {
        self.state = StreamState::Closed;
        let _ = self.ws_stream.close(None).await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::cipher::{
        aes_256_gcm_decrypt, aes_256_gcm_encrypt, generate_iv, hkdf_expand_64, sha256,
    };
    use crate::crypto::curve::{calculate_agreement, generate_key_pair};
    use crate::crypto::noise::{TransportState, NOISE_MODE, NOISE_WA_HEADER};
    use tokio_tungstenite::tungstenite::protocol::Role;

    #[tokio::test]
    async fn test_noise_handshake_and_encrypted_stream() {
        let (client_io, server_io) = tokio::io::duplex(65536);
        let client_ws = WebSocketStream::from_raw_socket(client_io, Role::Client, None).await;
        let mut server_ws =
            WebSocketStream::from_raw_socket(server_io, Role::Server, None).await;

        let client_e = generate_key_pair();
        let client_s = generate_key_pair();
        let server_e = generate_key_pair();
        let server_s = generate_key_pair();

        let client_handshake = HandshakeState::new(client_e.clone(), None, None);
        let mut client_stream = WhatsAppStream::from_raw_ws(client_ws, client_handshake);

        let s_client_e = client_e.clone();
        let s_client_s = client_s.clone();
        let s_server_e = server_e.clone();
        let s_server_s = server_s.clone();

        let server_task = tokio::spawn(async move {
            // 1. Read ClientHello
            let msg = server_ws.next().await.unwrap().unwrap();
            let mut client_hello_raw = match msg {
                Message::Binary(b) => b.to_vec(),
                _ => panic!("Expected binary message"),
            };

            assert!(client_hello_raw.starts_with(&NOISE_WA_HEADER));
            client_hello_raw.drain(0..NOISE_WA_HEADER.len());

            let len = ((client_hello_raw[0] as usize) << 16)
                | ((client_hello_raw[1] as usize) << 8)
                | (client_hello_raw[2] as usize);
            assert_eq!(len, 32);
            let c_epk = &client_hello_raw[3..35];
            assert_eq!(c_epk, &s_client_e.public[..]);

            // Setup Server Noise state
            let mut s_hash = *NOISE_MODE;
            let mut s_salt = s_hash;
            s_hash = sha256(&[&s_hash[..], &NOISE_WA_HEADER[..]].concat());
            s_hash = sha256(&[&s_hash[..], c_epk].concat());
            s_hash = sha256(&[&s_hash[..], &s_server_e.public[..]].concat());

            let s_dh1 = calculate_agreement(&s_server_e.private, c_epk).unwrap();
            let (sw, sr) = hkdf_expand_64(&s_salt, &s_dh1).unwrap();
            s_salt = sw;
            let s_enc = sr;
            let mut s_counter = 0;

            let iv1 = generate_iv(s_counter);
            let s_static_enc =
                aes_256_gcm_encrypt(&s_server_s.public, &s_enc, &iv1, &s_hash).unwrap();
            s_hash = sha256(&[&s_hash[..], &s_static_enc[..]].concat());

            let s_dh2 = calculate_agreement(&s_server_s.private, c_epk).unwrap();
            let (sw, sr) = hkdf_expand_64(&s_salt, &s_dh2).unwrap();
            s_salt = sw;
            let s_enc = sr;
            let mut s_dec = sr;
            s_counter = 0;

            let iv2 = generate_iv(s_counter);
            s_counter += 1;
            let server_payload = b"SERVER_PAYLOAD_TEST";
            let s_payload_enc =
                aes_256_gcm_encrypt(server_payload, &s_enc, &iv2, &s_hash).unwrap();
            s_hash = sha256(&[&s_hash[..], &s_payload_enc[..]].concat());

            // Build ServerHello frame
            let mut s_hello_body = Vec::new();
            s_hello_body.extend_from_slice(&s_server_e.public);
            s_hello_body.extend_from_slice(&s_static_enc);
            s_hello_body.extend_from_slice(&s_payload_enc);

            let s_len = s_hello_body.len();
            let mut s_frame = Vec::new();
            s_frame.push(((s_len >> 16) & 0xff) as u8);
            s_frame.push(((s_len >> 8) & 0xff) as u8);
            s_frame.push((s_len & 0xff) as u8);
            s_frame.extend_from_slice(&s_hello_body);

            server_ws.send(Message::Binary(s_frame.into())).await.unwrap();

            // 2. Read ClientFinish
            let msg2 = server_ws.next().await.unwrap().unwrap();
            let c_finish_raw = match msg2 {
                Message::Binary(b) => b.to_vec(),
                _ => panic!("Expected binary message"),
            };
            let c_finish_len = ((c_finish_raw[0] as usize) << 16)
                | ((c_finish_raw[1] as usize) << 8)
                | (c_finish_raw[2] as usize);
            let c_finish_payload = &c_finish_raw[3..3 + c_finish_len];

            let c_static_enc = &c_finish_payload[0..48];
            let c_payload_enc = &c_finish_payload[48..];

            let iv3 = generate_iv(s_counter);
            let s_dec_client_static =
                aes_256_gcm_decrypt(c_static_enc, &s_dec, &iv3, &s_hash).unwrap();
            assert_eq!(&s_dec_client_static[..], &s_client_s.public[..]);
            s_hash = sha256(&[&s_hash[..], c_static_enc].concat());

            let s_dh3 = calculate_agreement(&s_server_e.private, &s_client_s.public).unwrap();
            let (sw, sr) = hkdf_expand_64(&s_salt, &s_dh3).unwrap();
            s_dec = sr;
            s_counter = 0;

            let iv4 = generate_iv(s_counter);
            let s_dec_client_payload =
                aes_256_gcm_decrypt(c_payload_enc, &s_dec, &iv4, &s_hash).unwrap();
            assert_eq!(&s_dec_client_payload[..], b"CLIENT_PAYLOAD_TEST");

            // Server transitions to transport state
            let (s_write, s_read) = hkdf_expand_64(&sw, b"").unwrap();
            let mut server_transport = TransportState::new(s_read, s_write);

            // 3. Receive encrypted node from client
            let msg3 = server_ws.next().await.unwrap().unwrap();
            let node_frame_raw = match msg3 {
                Message::Binary(b) => b.to_vec(),
                _ => panic!("Expected binary message"),
            };
            let node_len = ((node_frame_raw[0] as usize) << 16)
                | ((node_frame_raw[1] as usize) << 8)
                | (node_frame_raw[2] as usize);
            let cipher_data = &node_frame_raw[3..3 + node_len];
            let plain_data = server_transport.decrypt(cipher_data).unwrap();
            let received_node = BinaryNode::decode_stanza(&plain_data).unwrap();
            assert_eq!(received_node.tag, "ping");

            // 4. Send back encrypted pong node
            let pong_node = BinaryNode::new_empty("pong");
            let pong_stanza = pong_node.encode_stanza();
            let enc_pong = server_transport.encrypt(&pong_stanza).unwrap();
            let mut pong_frame = Vec::new();
            pong_frame.push(((enc_pong.len() >> 16) & 0xff) as u8);
            pong_frame.push(((enc_pong.len() >> 8) & 0xff) as u8);
            pong_frame.push((enc_pong.len() & 0xff) as u8);
            pong_frame.extend_from_slice(&enc_pong);
            server_ws.send(Message::Binary(pong_frame.into())).await.unwrap();
        });

        // Client side executes handshake
        let client_payload = b"CLIENT_PAYLOAD_TEST";
        let res = client_stream
            .handshake(&client_s, client_payload)
            .await
            .unwrap();
        assert_eq!(res.server_static, server_s.public);
        assert_eq!(res.server_payload, b"SERVER_PAYLOAD_TEST");
        assert!(client_stream.is_transport_active());

        // Client sends encrypted node
        let ping_node = BinaryNode::new_empty("ping");
        client_stream.send_node(&ping_node).await.unwrap();

        // Client receives encrypted node
        let reply_node = client_stream.read_node().await.unwrap().unwrap();
        assert_eq!(reply_node.tag, "pong");

        server_task.await.unwrap();
    }
}
