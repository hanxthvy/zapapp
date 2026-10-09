// [xihanzu-NR]
//! WhatsApp Network Layer.
//! Provides Tokio async WebSocket transport, Noise XX handshake framing,
//! keepalive heartbeat management, and inbound/outbound stanza dispatching.

pub mod client;
pub mod stream;

pub use client::{
    HeartbeatManager, InboundEvent, NetworkClient, NetworkClientHandle, OutboundMessage,
    PendingQuery, StanzaDispatcher, StanzaHandler,
};
pub use stream::{
    HandshakeResult, NoiseStream, StreamState, WhatsAppStream, WA_ORIGIN, WA_USER_AGENT,
    WA_WS_URL,
};

use std::time::Duration;
use thiserror::Error;

/// Network and transport errors.
#[derive(Debug, Error)]
pub enum NetworkError {
    #[error("WebSocket error: {0}")]
    WebSocket(#[from] tokio_tungstenite::tungstenite::Error),

    #[error("Crypto error: {0}")]
    Crypto(#[from] crate::crypto::CryptoError),

    #[error("Proto error: {0}")]
    Proto(#[from] crate::proto::node::ProtoError),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Connection closed")]
    ConnectionClosed,

    #[error("Handshake failed: {0}")]
    Handshake(String),

    #[error("Heartbeat timeout: ping '{0}' not answered")]
    HeartbeatTimeout(String),

    #[error("Channel error: {0}")]
    Channel(String),

    #[error("Query timeout: id '{0}'")]
    QueryTimeout(String),

    #[error("Invalid URL or header: {0}")]
    Configuration(String),

    #[error("Protocol error: {0}")]
    Protocol(String),
}

/// Network configuration settings for WhatsApp WebSocket connections.
#[derive(Debug, Clone)]
pub struct NetworkConfig {
    /// Target WebSocket URL (defaults to wss://web.whatsapp.com/ws/chat).
    pub ws_url: String,
    /// Origin header (defaults to https://web.whatsapp.com).
    pub origin: String,
    /// User-Agent header.
    pub user_agent: String,
    /// Interval between keepalive ping stanzas.
    pub ping_interval: Duration,
    /// Maximum duration to wait for a pong response before timing out.
    pub ping_timeout: Duration,
    /// Connection establishment timeout.
    pub connect_timeout: Duration,
    /// Query response timeout.
    pub query_timeout: Duration,
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            ws_url: WA_WS_URL.to_string(),
            origin: WA_ORIGIN.to_string(),
            user_agent: WA_USER_AGENT.to_string(),
            ping_interval: Duration::from_secs(20),
            ping_timeout: Duration::from_secs(10),
            connect_timeout: Duration::from_secs(15),
            query_timeout: Duration::from_secs(15),
        }
    }
}

impl NetworkConfig {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_ws_url(mut self, url: impl Into<String>) -> Self {
        self.ws_url = url.into();
        self
    }

    pub fn with_ping_interval(mut self, interval: Duration) -> Self {
        self.ping_interval = interval;
        self
    }

    pub fn with_ping_timeout(mut self, timeout: Duration) -> Self {
        self.ping_timeout = timeout;
        self
    }
}

/// Connection lifecycle status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionStatus {
    Disconnected,
    Connecting,
    Handshaking,
    Connected,
    Closing,
}
