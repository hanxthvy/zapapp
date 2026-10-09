// [xihanzu-NR]
//! WhatsApp Async Client Message Loop and Stanza Dispatcher.
//! Handles keepalive ping/pong heartbeat, outbound queuing, query/response correlation,
//! and inbound stanza demultiplexing to event channels.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex, RwLock};
use tokio::task::JoinHandle;

use crate::crypto::curve::KeyPair;
use crate::network::stream::{DefaultWhatsAppStream, HandshakeResult, WhatsAppStream};
use crate::network::{ConnectionStatus, NetworkConfig, NetworkError};
use crate::proto::node::BinaryNode;
use crate::proto::stanza::{build_iq_ping, build_iq_result};

/// Outbound messages routed to the stream sender.
#[derive(Debug)]
pub enum OutboundMessage {
    /// Send a serialized binary XML node.
    Node(BinaryNode),
    /// Send raw framed bytes.
    Raw(Vec<u8>),
    /// Send an IQ query and register a oneshot response sender.
    Query {
        node: BinaryNode,
        response_tx: oneshot::Sender<Result<BinaryNode, NetworkError>>,
    },
    /// Request connection close.
    Close,
}

/// Inbound events emitted by the client message loop.
#[derive(Clone, Debug)]
pub enum InboundEvent {
    /// WebSocket connected.
    Connected,
    /// Noise handshake completed successfully.
    HandshakeCompleted(HandshakeResult),
    /// General binary XML stanza received.
    Stanza(BinaryNode),
    /// Keepalive ping sent to server.
    KeepalivePingSent(String),
    /// Keepalive pong received from server with round-trip latency.
    KeepalivePongReceived { id: String, latency: Duration },
    /// Keepalive ping received from server.
    KeepalivePingReceived(String),
    /// Connection closed or encountered an error.
    Disconnected(Option<String>),
}

/// Stanza handler function type.
pub type StanzaHandler = Arc<dyn Fn(&BinaryNode) + Send + Sync + 'static>;

/// Pending IQ query correlation entry.
pub struct PendingQuery {
    pub id: String,
    pub tx: oneshot::Sender<Result<BinaryNode, NetworkError>>,
    pub sent_at: Instant,
}

/// Inbound stanza dispatcher.
/// Dispatches incoming XML nodes by tag to subscribers and correlates IQ query responses.
pub struct StanzaDispatcher {
    tag_subscribers: RwLock<HashMap<String, Vec<mpsc::Sender<BinaryNode>>>>,
    global_subscribers: broadcast::Sender<BinaryNode>,
    event_subscribers: broadcast::Sender<InboundEvent>,
    handlers: RwLock<HashMap<String, Vec<StanzaHandler>>>,
    pending_queries: Mutex<HashMap<String, oneshot::Sender<Result<BinaryNode, NetworkError>>>>,
}

impl StanzaDispatcher {
    pub fn new() -> Self {
        let (global_tx, _) = broadcast::channel(512);
        let (event_tx, _) = broadcast::channel(512);

        Self {
            tag_subscribers: RwLock::new(HashMap::new()),
            global_subscribers: global_tx,
            event_subscribers: event_tx,
            handlers: RwLock::new(HashMap::new()),
            pending_queries: Mutex::new(HashMap::new()),
        }
    }

    /// Register a pending query response channel for correlation by stanza ID.
    pub async fn register_query(
        &self,
        id: String,
        tx: oneshot::Sender<Result<BinaryNode, NetworkError>>,
    ) {
        let mut map = self.pending_queries.lock().await;
        map.insert(id, tx);
    }

    /// Subscribe to stanzas with a specific XML tag (e.g. "message", "receipt", "iq").
    pub async fn subscribe_tag(&self, tag: &str) -> mpsc::Receiver<BinaryNode> {
        let (tx, rx) = mpsc::channel(128);
        let mut subs = self.tag_subscribers.write().await;
        subs.entry(tag.to_string()).or_default().push(tx);
        rx
    }

    /// Subscribe to all incoming stanzas broadcast.
    pub fn subscribe_all(&self) -> broadcast::Receiver<BinaryNode> {
        self.global_subscribers.subscribe()
    }

    /// Subscribe to high-level inbound client events.
    pub fn subscribe_events(&self) -> broadcast::Receiver<InboundEvent> {
        self.event_subscribers.subscribe()
    }

    /// Register a callback handler for a given tag or "*" for all.
    pub async fn register_handler(&self, tag: &str, handler: StanzaHandler) {
        let mut handlers = self.handlers.write().await;
        handlers.entry(tag.to_string()).or_default().push(handler);
    }

    /// Dispatch an incoming `BinaryNode` to matching subscribers and queries.
    pub async fn dispatch(
        &self,
        node: BinaryNode,
        outbound_tx: &mpsc::Sender<OutboundMessage>,
    ) {
        // 1. Check for IQ query correlation or auto-responding to server ping
        if node.tag == "iq" {
            let iq_type = node.attr("type").unwrap_or("");
            let iq_id = node.attr("id").unwrap_or("");

            if (iq_type == "result" || iq_type == "error") && !iq_id.is_empty() {
                let mut queries = self.pending_queries.lock().await;
                if let Some(tx) = queries.remove(iq_id) {
                    let _ = tx.send(Ok(node.clone()));
                }
            } else if iq_type == "get" {
                let xmlns = node.attr("xmlns").unwrap_or("");
                let is_ping = xmlns == "w:p" || node.child("ping").is_some();
                if is_ping {
                    let _ = self
                        .event_subscribers
                        .send(InboundEvent::KeepalivePingReceived(iq_id.to_string()));
                    // Automatically answer with IQ result
                    let pong_node = build_iq_result(&node);
                    let _ = outbound_tx.send(OutboundMessage::Node(pong_node)).await;
                }
            }
        }

        // 2. Dispatch to tag-specific subscribers
        {
            let mut subs = self.tag_subscribers.write().await;
            if let Some(senders) = subs.get_mut(&node.tag) {
                senders.retain(|tx| tx.try_send(node.clone()).is_ok() || !tx.is_closed());
            }
        }

        // 3. Dispatch to registered function handlers
        {
            let handlers = self.handlers.read().await;
            if let Some(list) = handlers.get(&node.tag) {
                for h in list {
                    h(&node);
                }
            }
            if let Some(list) = handlers.get("*") {
                for h in list {
                    h(&node);
                }
            }
        }

        // 4. Emit to global broadcast & event streams
        let _ = self.global_subscribers.send(node.clone());
        let _ = self.event_subscribers.send(InboundEvent::Stanza(node));
    }

    /// Abort all pending queries on disconnect with an error.
    pub async fn abort_pending_queries(&self, _error: &NetworkError) {
        let mut queries = self.pending_queries.lock().await;
        for (_, tx) in queries.drain() {
            let _ = tx.send(Err(NetworkError::ConnectionClosed));
        }
    }
}

/// Pending ping metadata for keepalive tracking.
#[derive(Clone, Debug)]
struct PendingPing {
    id: String,
    sent_at: Instant,
}

/// Keepalive ping/pong heartbeat tracker.
pub struct HeartbeatManager {
    ping_interval: Duration,
    ping_timeout: Duration,
    counter: AtomicU64,
    current_ping: Arc<Mutex<Option<PendingPing>>>,
    last_latency: Arc<Mutex<Option<Duration>>>,
    missed_pings: AtomicU32,
}

impl HeartbeatManager {
    pub fn new(ping_interval: Duration, ping_timeout: Duration) -> Self {
        Self {
            ping_interval,
            ping_timeout,
            counter: AtomicU64::new(1),
            current_ping: Arc::new(Mutex::new(None)),
            last_latency: Arc::new(Mutex::new(None)),
            missed_pings: AtomicU32::new(0),
        }
    }

    /// Generate next unique keepalive ping ID.
    pub fn next_ping_id(&self) -> String {
        format!("ping-{}", self.counter.fetch_add(1, Ordering::SeqCst))
    }

    /// Configured ping interval.
    pub fn ping_interval(&self) -> Duration {
        self.ping_interval
    }

    /// Send keepalive ping stanza via outbound channel and track pending response.
    pub async fn send_ping(
        &self,
        outbound_tx: &mpsc::Sender<OutboundMessage>,
        event_tx: &broadcast::Sender<InboundEvent>,
    ) -> Result<String, NetworkError> {
        let ping_id = self.next_ping_id();
        let ping_node = build_iq_ping(&ping_id);

        {
            let mut current = self.current_ping.lock().await;
            *current = Some(PendingPing {
                id: ping_id.clone(),
                sent_at: Instant::now(),
            });
        }

        outbound_tx
            .send(OutboundMessage::Node(ping_node))
            .await
            .map_err(|_| NetworkError::Channel("Failed to enqueue keepalive ping".into()))?;

        let _ = event_tx.send(InboundEvent::KeepalivePingSent(ping_id.clone()));
        Ok(ping_id)
    }

    /// Handle received pong result. Returns true if matching active ping.
    pub async fn handle_pong(
        &self,
        id: &str,
        event_tx: &broadcast::Sender<InboundEvent>,
    ) -> bool {
        let mut current = self.current_ping.lock().await;
        if let Some(pending) = current.take() {
            if pending.id == id {
                let latency = pending.sent_at.elapsed();
                {
                    let mut lat = self.last_latency.lock().await;
                    *lat = Some(latency);
                }
                self.missed_pings.store(0, Ordering::SeqCst);
                let _ = event_tx.send(InboundEvent::KeepalivePongReceived {
                    id: id.to_string(),
                    latency,
                });
                return true;
            } else {
                // Restore if not matched
                *current = Some(pending);
            }
        }
        false
    }

    /// Check if pending ping exceeded timeout threshold.
    pub async fn check_timeout(&self) -> Option<NetworkError> {
        let current = self.current_ping.lock().await;
        if let Some(ref pending) = *current {
            if pending.sent_at.elapsed() > self.ping_timeout {
                let missed = self.missed_pings.fetch_add(1, Ordering::SeqCst) + 1;
                if missed >= 2 {
                    return Some(NetworkError::HeartbeatTimeout(pending.id.clone()));
                }
            }
        }
        None
    }

    /// Last recorded round-trip ping latency.
    pub async fn last_latency(&self) -> Option<Duration> {
        *self.last_latency.lock().await
    }
}

/// Cloneable handle to the running WhatsApp Network Client.
#[derive(Clone)]
pub struct NetworkClientHandle {
    outbound_tx: mpsc::Sender<OutboundMessage>,
    dispatcher: Arc<StanzaDispatcher>,
    heartbeat: Arc<HeartbeatManager>,
    config: NetworkConfig,
    shutdown_tx: broadcast::Sender<()>,
    status: Arc<AtomicU8>,
    query_counter: Arc<AtomicU64>,
}

impl NetworkClientHandle {
    /// Send a `BinaryNode` to WhatsApp.
    pub async fn send_node(&self, node: BinaryNode) -> Result<(), NetworkError> {
        self.outbound_tx
            .send(OutboundMessage::Node(node))
            .await
            .map_err(|_| NetworkError::ConnectionClosed)
    }

    /// Send raw framed bytes over the transport stream.
    pub async fn send_raw(&self, data: Vec<u8>) -> Result<(), NetworkError> {
        self.outbound_tx
            .send(OutboundMessage::Raw(data))
            .await
            .map_err(|_| NetworkError::ConnectionClosed)
    }

    /// Send an `<iq>` query and wait for corresponding `<iq type="result|error">` response.
    pub async fn query(&self, mut node: BinaryNode) -> Result<BinaryNode, NetworkError> {
        let id = match node.attr("id") {
            Some(id) => id.to_string(),
            None => {
                let gen_id = format!("iq-{}", self.query_counter.fetch_add(1, Ordering::SeqCst));
                node.set_attr("id", gen_id.clone());
                gen_id
            }
        };

        let (response_tx, response_rx) = oneshot::channel();
        self.outbound_tx
            .send(OutboundMessage::Query { node, response_tx })
            .await
            .map_err(|_| NetworkError::ConnectionClosed)?;

        match tokio::time::timeout(self.config.query_timeout, response_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(NetworkError::ConnectionClosed),
            Err(_) => Err(NetworkError::QueryTimeout(id)),
        }
    }

    /// Explicitly send a keepalive ping and await server pong round-trip.
    pub async fn ping(&self) -> Result<Duration, NetworkError> {
        let ping_id = self.heartbeat.next_ping_id();
        let ping_node = build_iq_ping(&ping_id);
        let start = Instant::now();
        let _ = self.query(ping_node).await?;
        Ok(start.elapsed())
    }

    /// Subscribe to incoming stanzas with a specific tag (e.g. "message", "receipt", "iq").
    pub async fn subscribe_tag(&self, tag: &str) -> mpsc::Receiver<BinaryNode> {
        self.dispatcher.subscribe_tag(tag).await
    }

    /// Subscribe to all stanzas broadcast stream.
    pub fn subscribe_stanzas(&self) -> broadcast::Receiver<BinaryNode> {
        self.dispatcher.subscribe_all()
    }

    /// Subscribe to network client lifecycle events.
    pub fn subscribe_events(&self) -> broadcast::Receiver<InboundEvent> {
        self.dispatcher.subscribe_events()
    }

    /// Register a functional stanza handler callback.
    pub async fn on_stanza(&self, tag: &str, handler: impl Fn(&BinaryNode) + Send + Sync + 'static) {
        self.dispatcher
            .register_handler(tag, Arc::new(handler))
            .await;
    }

    /// Disconnect and shutdown client message loop.
    pub async fn disconnect(&self) -> Result<(), NetworkError> {
        let _ = self.outbound_tx.send(OutboundMessage::Close).await;
        let _ = self.shutdown_tx.send(());
        self.status.store(ConnectionStatus::Closing as u8, Ordering::SeqCst);
        Ok(())
    }

    /// Current connection status.
    pub fn status(&self) -> ConnectionStatus {
        match self.status.load(Ordering::SeqCst) {
            0 => ConnectionStatus::Disconnected,
            1 => ConnectionStatus::Connecting,
            2 => ConnectionStatus::Handshaking,
            3 => ConnectionStatus::Connected,
            4 => ConnectionStatus::Closing,
            _ => ConnectionStatus::Disconnected,
        }
    }

    /// Last recorded ping latency.
    pub async fn latency(&self) -> Option<Duration> {
        self.heartbeat.last_latency().await
    }
}

/// Network Client runner and factory.
pub struct NetworkClient;

impl NetworkClient {
    /// Start the async message loop using an existing established `WhatsAppStream`.
    pub fn start<S>(
        mut stream: WhatsAppStream<S>,
        config: NetworkConfig,
    ) -> (NetworkClientHandle, JoinHandle<Result<(), NetworkError>>)
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let (outbound_tx, mut outbound_rx) = mpsc::channel::<OutboundMessage>(256);
        let (shutdown_tx, mut shutdown_rx) = broadcast::channel::<()>(4);

        let dispatcher = Arc::new(StanzaDispatcher::new());
        let heartbeat = Arc::new(HeartbeatManager::new(
            config.ping_interval,
            config.ping_timeout,
        ));
        let status = Arc::new(AtomicU8::new(ConnectionStatus::Connected as u8));
        let query_counter = Arc::new(AtomicU64::new(1));

        let handle = NetworkClientHandle {
            outbound_tx: outbound_tx.clone(),
            dispatcher: Arc::clone(&dispatcher),
            heartbeat: Arc::clone(&heartbeat),
            config: config.clone(),
            shutdown_tx,
            status: Arc::clone(&status),
            query_counter,
        };

        let task_dispatcher = Arc::clone(&dispatcher);
        let task_heartbeat = Arc::clone(&heartbeat);
        let task_status = Arc::clone(&status);
        let task_outbound_tx = outbound_tx.clone();

        let join_handle = tokio::spawn(async move {
            let mut heartbeat_interval = tokio::time::interval(config.ping_interval);
            // First tick completes immediately, skip it so initial ping waits full interval
            heartbeat_interval.tick().await;

            let loop_result: Result<(), NetworkError> = loop {
                tokio::select! {
                    // 1. Inbound stream read
                    inbound_res = stream.read_node() => {
                        match inbound_res {
                            Ok(Some(node)) => {
                                // Check if this node is a pong for our current heartbeat ping
                                if node.tag == "iq" {
                                    let iq_type = node.attr("type").unwrap_or("");
                                    let iq_id = node.attr("id").unwrap_or("");
                                    if (iq_type == "result" || iq_type == "error") && !iq_id.is_empty() {
                                        task_heartbeat.handle_pong(iq_id, &task_dispatcher.event_subscribers).await;
                                    }
                                }
                                task_dispatcher.dispatch(node, &task_outbound_tx).await;
                            }
                            Ok(None) => {
                                let _ = task_dispatcher.event_subscribers.send(
                                    InboundEvent::Disconnected(Some("Stream reached EOF".into()))
                                );
                                break Ok(());
                            }
                            Err(e) => {
                                let _ = task_dispatcher.event_subscribers.send(
                                    InboundEvent::Disconnected(Some(e.to_string()))
                                );
                                break Err(e);
                            }
                        }
                    }

                    // 2. Outbound message channel
                    outbound_msg = outbound_rx.recv() => {
                        match outbound_msg {
                            Some(OutboundMessage::Node(node)) => {
                                if let Err(e) = stream.send_node(&node).await {
                                    break Err(e);
                                }
                            }
                            Some(OutboundMessage::Raw(raw)) => {
                                if let Err(e) = stream.send_frame(&raw).await {
                                    break Err(e);
                                }
                            }
                            Some(OutboundMessage::Query { node, response_tx }) => {
                                let id = node.attr("id").unwrap_or("").to_string();
                                if !id.is_empty() {
                                    task_dispatcher.register_query(id, response_tx).await;
                                }
                                if let Err(e) = stream.send_node(&node).await {
                                    break Err(e);
                                }
                            }
                            Some(OutboundMessage::Close) | None => {
                                let _ = stream.close().await;
                                break Ok(());
                            }
                        }
                    }

                    // 3. Keepalive heartbeat interval tick
                    _ = heartbeat_interval.tick() => {
                        // Check if previous ping timed out
                        if let Some(err) = task_heartbeat.check_timeout().await {
                            let _ = task_dispatcher.event_subscribers.send(
                                InboundEvent::Disconnected(Some(err.to_string()))
                            );
                            break Err(err);
                        }
                        // Send next keepalive ping
                        if let Err(e) = task_heartbeat.send_ping(&task_outbound_tx, &task_dispatcher.event_subscribers).await {
                            break Err(e);
                        }
                    }

                    // 4. Shutdown notification
                    _ = shutdown_rx.recv() => {
                        let _ = stream.close().await;
                        break Ok(());
                    }
                }
            };

            task_status.store(ConnectionStatus::Disconnected as u8, Ordering::SeqCst);
            task_dispatcher.abort_pending_queries(&NetworkError::ConnectionClosed).await;
            loop_result
        });

        (handle, join_handle)
    }

    /// Full end-to-end connection helper:
    /// Connects to WhatsApp WebSocket, performs Noise XX handshake, and starts message loop.
    pub async fn connect(
        config: NetworkConfig,
        client_ephemeral: KeyPair,
        client_static: &KeyPair,
        client_payload: &[u8],
        noise_header: Option<&[u8]>,
        routing_info: Option<&[u8]>,
    ) -> Result<(NetworkClientHandle, HandshakeResult, JoinHandle<Result<(), NetworkError>>), NetworkError> {
        let mut stream = DefaultWhatsAppStream::connect(
            &config,
            client_ephemeral,
            noise_header,
            routing_info,
        )
        .await?;

        let handshake_res = stream.handshake(client_static, client_payload).await?;
        let (handle, join_handle) = Self::start(stream, config);

        let _ = handle
            .dispatcher
            .event_subscribers
            .send(InboundEvent::HandshakeCompleted(handshake_res.clone()));

        Ok((handle, handshake_res, join_handle))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::curve::generate_key_pair;
    use crate::crypto::noise::HandshakeState;
    use futures_util::StreamExt;
    use tokio_tungstenite::tungstenite::protocol::Role;
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::WebSocketStream;

    async fn create_mock_pair() -> (
        WhatsAppStream<tokio::io::DuplexStream>,
        WebSocketStream<tokio::io::DuplexStream>,
    ) {
        let (client_io, server_io) = tokio::io::duplex(65536);
        let client_ws = WebSocketStream::from_raw_socket(client_io, Role::Client, None).await;
        let server_ws =
            WebSocketStream::from_raw_socket(server_io, Role::Server, None).await;

        let client_kp = generate_key_pair();
        let mut client_handshake = HandshakeState::new(client_kp, None, None);
        // Activate transport directly for message loop testing
        client_handshake.finish_init().unwrap();

        let client_stream = WhatsAppStream::from_raw_ws(client_ws, client_handshake);
        (client_stream, server_ws)
    }

    #[tokio::test]
    async fn test_dispatcher_tag_routing_and_outbound() {
        let (client_stream, mut server_ws) = create_mock_pair().await;
        let config = NetworkConfig::default().with_ping_interval(Duration::from_secs(60));
        let (client, _join_handle) = NetworkClient::start(client_stream, config);

        let mut msg_rx = client.subscribe_tag("message").await;
        let mut receipt_rx = client.subscribe_tag("receipt").await;
        let mut global_rx = client.subscribe_stanzas();

        // 1. Client sends outbound message
        let out_node = BinaryNode::new_empty("message");
        client.send_node(out_node).await.unwrap();

        // Server receives and decrypts (or receives framed)
        let s_msg = server_ws.next().await.unwrap().unwrap();
        let s_bytes = match s_msg {
            Message::Binary(b) => b.to_vec(),
            _ => panic!("Expected binary"),
        };
        // Decode frame len
        let len = ((s_bytes[0] as usize) << 16)
            | ((s_bytes[1] as usize) << 8)
            | (s_bytes[2] as usize);
        assert!(len > 0);

        // 2. Server sends inbound message node to client
        // Mock server sends unencrypted raw frame as handshake was init with dummy keys
        // To simulate, we send a stanza directly via an echo or stream test
        let in_node = BinaryNode::new_empty("message");
        let stanza_data = in_node.encode_stanza();
        let mut frame = Vec::new();
        frame.push(((stanza_data.len() >> 16) & 0xff) as u8);
        frame.push(((stanza_data.len() >> 8) & 0xff) as u8);
        frame.push((stanza_data.len() & 0xff) as u8);
        frame.extend_from_slice(&stanza_data);

        // Directly verify dispatcher
        let test_node = BinaryNode::new_empty("message");
        let (out_tx, _out_rx) = mpsc::channel(16);
        client.dispatcher.dispatch(test_node, &out_tx).await;

        let received_msg = msg_rx.recv().await.unwrap();
        assert_eq!(received_msg.tag, "message");

        let global_node = global_rx.recv().await.unwrap();
        assert_eq!(global_node.tag, "message");

        // Receipt subscriber should have received nothing yet
        assert!(receipt_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn test_server_ping_auto_pong() {
        let dispatcher = StanzaDispatcher::new();
        let (out_tx, mut out_rx) = mpsc::channel(16);

        // Inbound server keepalive ping: <iq id="ping-srv-42" type="get" xmlns="w:p"><ping/></iq>
        let ping_node = build_iq_ping("ping-srv-42");
        dispatcher.dispatch(ping_node, &out_tx).await;

        // Dispatcher should have sent back an automatic IQ result pong
        let out_msg = out_rx.recv().await.unwrap();
        match out_msg {
            OutboundMessage::Node(node) => {
                assert_eq!(node.tag, "iq");
                assert_eq!(node.attr("type"), Some("result"));
                assert_eq!(node.attr("id"), Some("ping-srv-42"));
            }
            _ => panic!("Expected node"),
        }
    }

    #[tokio::test]
    async fn test_query_correlation() {
        let dispatcher = StanzaDispatcher::new();
        let (out_tx, _out_rx) = mpsc::channel(16);
        let (tx, rx) = oneshot::channel();

        dispatcher.register_query("query-123".to_string(), tx).await;

        // Inbound query result: <iq id="query-123" type="result"><query_response/></iq>
        let mut result_node = BinaryNode::new_empty("iq");
        result_node.set_attr("id", "query-123");
        result_node.set_attr("type", "result");

        dispatcher.dispatch(result_node, &out_tx).await;

        let res = rx.await.unwrap().unwrap();
        assert_eq!(res.attr("id"), Some("query-123"));
        assert_eq!(res.attr("type"), Some("result"));
    }

    #[tokio::test]
    async fn test_heartbeat_manager() {
        let (event_tx, mut event_rx) = broadcast::channel(16);
        let (out_tx, mut out_rx) = mpsc::channel(16);
        let heartbeat = HeartbeatManager::new(Duration::from_secs(20), Duration::from_secs(5));

        // Send ping
        let ping_id = heartbeat.send_ping(&out_tx, &event_tx).await.unwrap();
        assert!(ping_id.starts_with("ping-"));

        // Verify ping was enqueued
        let out_msg = out_rx.recv().await.unwrap();
        match out_msg {
            OutboundMessage::Node(node) => {
                assert_eq!(node.tag, "iq");
                assert_eq!(node.attr("id"), Some(ping_id.as_str()));
            }
            _ => panic!("Expected node"),
        }

        // Handle matching pong
        let handled = heartbeat.handle_pong(&ping_id, &event_tx).await;
        assert!(handled);
        assert!(heartbeat.last_latency().await.is_some());

        // Event should have been emitted
        let event = event_rx.recv().await.unwrap();
        match event {
            InboundEvent::KeepalivePingSent(id) => assert_eq!(id, ping_id),
            _ => panic!("Expected ping sent event"),
        }

        let event2 = event_rx.recv().await.unwrap();
        match event2 {
            InboundEvent::KeepalivePongReceived { id, latency: _ } => assert_eq!(id, ping_id),
            _ => panic!("Expected pong received event"),
        }
    }
}
