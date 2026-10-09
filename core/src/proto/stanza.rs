// [xihanzu-NR]
//! WhatsApp Binary XML Stanza Builders and Protobuf Bridge.
//! Provides builders for <message>, <biz>, <enc>, <receipt>, <iq> stanzas
//! and wire serialization / padding helpers for Protobuf payloads.

use crate::proto::node::{BinaryNode, NodeAttrs, ProtoError};
use crate::proto::tokens::HOST_DOMAIN;

// ---------------------------------------------------------------------------
// Protocol Tag & Type Constants
// ---------------------------------------------------------------------------

pub const TAG_MESSAGE: &str = "message";
pub const TAG_ENC: &str = "enc";
pub const TAG_RECEIPT: &str = "receipt";
pub const TAG_ACK: &str = "ack";
pub const TAG_ERROR: &str = "error";
pub const TAG_IQ: &str = "iq";
pub const TAG_BIZ: &str = "biz";
pub const TAG_PARTICIPANTS: &str = "participants";
pub const TAG_TO: &str = "to";
pub const TAG_BOT: &str = "bot";
pub const TAG_DEVICE_IDENTITY: &str = "device-identity";
pub const TAG_INTERACTIVE: &str = "interactive";
pub const TAG_NATIVE_FLOW: &str = "native_flow";
pub const TAG_LIST: &str = "list";
pub const TAG_ITEM: &str = "item";
pub const TAG_RETRY: &str = "retry";

pub const ENC_VERSION: &str = "2";
pub const ENC_TYPE_MSG: &str = "msg";
pub const ENC_TYPE_PKMSG: &str = "pkmsg";
pub const ENC_TYPE_SKMSG: &str = "skmsg";
pub const ENC_TYPE_MSMSG: &str = "msmsg";

pub const IQ_TYPE_GET: &str = "get";
pub const IQ_TYPE_SET: &str = "set";
pub const IQ_TYPE_RESULT: &str = "result";
pub const IQ_TYPE_ERROR: &str = "error";

pub const RECEIPT_TYPE_DELIVERY: &str = "delivery";
pub const RECEIPT_TYPE_READ: &str = "read";
pub const RECEIPT_TYPE_PLAYED: &str = "played";
pub const RECEIPT_TYPE_RETRY: &str = "retry";
pub const RECEIPT_TYPE_PEER: &str = "peer_msg";
pub const RECEIPT_TYPE_SERVER_ERROR: &str = "server-error";

// ---------------------------------------------------------------------------
// <enc> Stanza Builder
// ---------------------------------------------------------------------------

/// Builds an `<enc>` binary XML node for encrypted message payloads.
/// Attributes: `v="2"`, `type=enc_type`, optional `mediatype`, optional `count`, optional `decrypt-fail`.
pub fn build_enc_node(
    enc_type: &str,
    ciphertext: Vec<u8>,
    mediatype: Option<&str>,
    retry_count: Option<u32>,
    decrypt_fail: Option<&str>,
) -> BinaryNode {
    let mut attrs = NodeAttrs::new();
    attrs.insert("v", ENC_VERSION);
    attrs.insert("type", enc_type);
    if let Some(m) = mediatype {
        attrs.insert("mediatype", m);
    }
    if let Some(c) = retry_count {
        if c > 0 {
            attrs.insert("count", c.to_string());
        }
    }
    if let Some(df) = decrypt_fail {
        attrs.insert("decrypt-fail", df);
    }
    BinaryNode::new_with_bytes(TAG_ENC, attrs, ciphertext)
}

// ---------------------------------------------------------------------------
// <biz> Stanza Builder (Button Addons & Interactive Flows)
// ---------------------------------------------------------------------------

/// Supported button addon kinds for `<biz>` nodes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ButtonAddonKind {
    /// Product list button (<biz><list type="product_list" v="2"/></biz>)
    List,
    /// Generic interactive button flow (<biz><interactive type="native_flow" v="1"><native_flow v="9" name="mixed"/></interactive></biz>)
    Interactive,
    /// Pix / payment button flow (<biz><interactive type="native_flow" v="1"><native_flow name="payment_info"/></interactive></biz>)
    PaymentInfo,
    /// Order details / review flow (<biz><interactive type="native_flow" v="1"><native_flow name="order_details"/></interactive></biz>)
    OrderDetails,
}

/// Builds a `<biz>` button addon node mirroring zapo's `buildButtonAddonNode`.
pub fn build_button_addon_node(kind: ButtonAddonKind) -> BinaryNode {
    match kind {
        ButtonAddonKind::List => {
            let mut list_attrs = NodeAttrs::new();
            list_attrs.insert("type", "product_list");
            list_attrs.insert("v", "2");
            let list_node = BinaryNode::new_with_attrs(TAG_LIST, list_attrs);
            BinaryNode::new_with_children(TAG_BIZ, NodeAttrs::new(), vec![list_node])
        }
        ButtonAddonKind::Interactive => {
            let mut flow_attrs = NodeAttrs::new();
            flow_attrs.insert("name", "mixed");
            flow_attrs.insert("v", "9");
            let flow_node = BinaryNode::new_with_attrs(TAG_NATIVE_FLOW, flow_attrs);

            let mut inter_attrs = NodeAttrs::new();
            inter_attrs.insert("type", TAG_NATIVE_FLOW);
            inter_attrs.insert("v", "1");
            let inter_node =
                BinaryNode::new_with_children(TAG_INTERACTIVE, inter_attrs, vec![flow_node]);

            BinaryNode::new_with_children(TAG_BIZ, NodeAttrs::new(), vec![inter_node])
        }
        ButtonAddonKind::PaymentInfo => {
            let mut flow_attrs = NodeAttrs::new();
            flow_attrs.insert("name", "payment_info");
            let flow_node = BinaryNode::new_with_attrs(TAG_NATIVE_FLOW, flow_attrs);

            let mut inter_attrs = NodeAttrs::new();
            inter_attrs.insert("type", TAG_NATIVE_FLOW);
            inter_attrs.insert("v", "1");
            let inter_node =
                BinaryNode::new_with_children(TAG_INTERACTIVE, inter_attrs, vec![flow_node]);

            BinaryNode::new_with_children(TAG_BIZ, NodeAttrs::new(), vec![inter_node])
        }
        ButtonAddonKind::OrderDetails => {
            let mut flow_attrs = NodeAttrs::new();
            flow_attrs.insert("name", "order_details");
            let flow_node = BinaryNode::new_with_attrs(TAG_NATIVE_FLOW, flow_attrs);

            let mut inter_attrs = NodeAttrs::new();
            inter_attrs.insert("type", TAG_NATIVE_FLOW);
            inter_attrs.insert("v", "1");
            let inter_node =
                BinaryNode::new_with_children(TAG_INTERACTIVE, inter_attrs, vec![flow_node]);

            BinaryNode::new_with_children(TAG_BIZ, NodeAttrs::new(), vec![inter_node])
        }
    }
}

/// Builds a generic `<biz>` node with custom child nodes.
pub fn build_biz_node(children: Vec<BinaryNode>) -> BinaryNode {
    BinaryNode::new_with_children(TAG_BIZ, NodeAttrs::new(), children)
}

// ---------------------------------------------------------------------------
// <message> Stanza Builder
// ---------------------------------------------------------------------------

/// Participant in direct or group message fanout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedParticipant {
    pub jid: String,
    pub enc_type: Option<String>,
    pub ciphertext: Option<Vec<u8>>,
}

impl EncryptedParticipant {
    pub fn new(
        jid: impl Into<String>,
        enc_type: impl Into<String>,
        ciphertext: Vec<u8>,
    ) -> Self {
        Self {
            jid: jid.into(),
            enc_type: Some(enc_type.into()),
            ciphertext: Some(ciphertext),
        }
    }

    pub fn bare(jid: impl Into<String>) -> Self {
        Self {
            jid: jid.into(),
            enc_type: None,
            ciphertext: None,
        }
    }
}

/// Outbound `<message>` stanza attributes.
#[derive(Debug, Clone, Default)]
pub struct MessageAttrs {
    pub to: String,
    pub msg_type: String,
    pub id: Option<String>,
    pub edit: Option<String>,
    pub phash: Option<String>,
    pub addressing_mode: Option<String>,
    pub peer_recipient_pn: Option<String>,
    pub participant: Option<String>,
    pub extra: Vec<(String, String)>,
}

impl MessageAttrs {
    pub fn new(to: impl Into<String>, msg_type: impl Into<String>) -> Self {
        Self {
            to: to.into(),
            msg_type: msg_type.into(),
            ..Default::default()
        }
    }

    pub fn to_node_attrs(&self) -> NodeAttrs {
        let mut attrs = NodeAttrs::new();
        attrs.insert("to", &self.to);
        attrs.insert("type", &self.msg_type);
        if let Some(id) = &self.id {
            attrs.insert("id", id);
        }
        if let Some(edit) = &self.edit {
            attrs.insert("edit", edit);
        }
        if let Some(phash) = &self.phash {
            attrs.insert("phash", phash);
        }
        if let Some(mode) = &self.addressing_mode {
            attrs.insert("addressing_mode", mode);
        }
        if let Some(pn) = &self.peer_recipient_pn {
            attrs.insert("peer_recipient_pn", pn);
        }
        if let Some(p) = &self.participant {
            attrs.insert("participant", p);
        }
        for (k, v) in &self.extra {
            attrs.insert(k, v);
        }
        attrs
    }
}

/// Builds a single `<to jid="...">` node containing its encrypted `<enc>` payload.
pub fn build_encrypted_to_node(
    p: &EncryptedParticipant,
    mediatype: Option<&str>,
    decrypt_fail: Option<&str>,
) -> BinaryNode {
    let mut attrs = NodeAttrs::new();
    attrs.insert("jid", &p.jid);
    match (&p.enc_type, &p.ciphertext) {
        (Some(enc_type), Some(ciphertext)) => {
            let enc_node =
                build_enc_node(enc_type, ciphertext.clone(), mediatype, None, decrypt_fail);
            BinaryNode::new_with_children(TAG_TO, attrs, vec![enc_node])
        }
        _ => BinaryNode::new_with_attrs(TAG_TO, attrs),
    }
}

/// Builds `<to>` nodes for a list of participants.
pub fn build_encrypted_to_nodes(
    participants: &[EncryptedParticipant],
    mediatype: Option<&str>,
    decrypt_fail: Option<&str>,
) -> Vec<BinaryNode> {
    participants
        .iter()
        .map(|p| build_encrypted_to_node(p, mediatype, decrypt_fail))
        .collect()
}

/// Builds a 1:1 or broadcast direct fanout `<message>` stanza mirroring zapo.
pub fn build_direct_message_fanout_node(
    attrs: MessageAttrs,
    participants: Vec<EncryptedParticipant>,
    custom_nodes: Vec<BinaryNode>,
    device_identity: Option<Vec<u8>>,
    bot_participants: Vec<EncryptedParticipant>,
    mediatype: Option<&str>,
) -> BinaryNode {
    let to_nodes = build_encrypted_to_nodes(&participants, mediatype, None);
    let participants_node =
        BinaryNode::new_with_children(TAG_PARTICIPANTS, NodeAttrs::new(), to_nodes);

    let mut content = vec![participants_node];

    if let Some(di) = device_identity {
        content.push(BinaryNode::new_with_bytes(
            TAG_DEVICE_IDENTITY,
            NodeAttrs::new(),
            di,
        ));
    }
    content.extend(custom_nodes);

    if !bot_participants.is_empty() {
        let bot_to_nodes = build_encrypted_to_nodes(&bot_participants, mediatype, None);
        content.push(BinaryNode::new_with_children(
            TAG_BOT,
            NodeAttrs::new(),
            bot_to_nodes,
        ));
    }

    BinaryNode::new_with_children(TAG_MESSAGE, attrs.to_node_attrs(), content)
}

/// Builds a group sender key message stanza mirroring zapo's `buildGroupSenderKeyMessageNode`.
pub fn build_group_sender_key_message_node(
    attrs: MessageAttrs,
    group_ciphertext: Vec<u8>,
    participants: Vec<EncryptedParticipant>,
    custom_nodes: Vec<BinaryNode>,
    device_identity: Option<Vec<u8>>,
    mediatype: Option<&str>,
) -> BinaryNode {
    let mut content = Vec::new();

    if !participants.is_empty() {
        let to_nodes = build_encrypted_to_nodes(&participants, mediatype, None);
        content.push(BinaryNode::new_with_children(
            TAG_PARTICIPANTS,
            NodeAttrs::new(),
            to_nodes,
        ));
    }

    content.push(build_enc_node(
        ENC_TYPE_SKMSG,
        group_ciphertext,
        mediatype,
        None,
        None,
    ));

    if let Some(di) = device_identity {
        content.push(BinaryNode::new_with_bytes(
            TAG_DEVICE_IDENTITY,
            NodeAttrs::new(),
            di,
        ));
    }
    content.extend(custom_nodes);

    BinaryNode::new_with_children(TAG_MESSAGE, attrs.to_node_attrs(), content)
}

/// Builds a group retry message stanza mirroring zapo's `buildGroupRetryMessageNode`.
pub fn build_group_retry_message_node(
    to: &str,
    msg_type: &str,
    id: &str,
    requester_jid: &str,
    enc_type: &str,
    ciphertext: Vec<u8>,
    retry_count: u32,
    addressing_mode: Option<&str>,
    meta_node: Option<BinaryNode>,
    device_identity: Option<Vec<u8>>,
    mediatype: Option<&str>,
) -> BinaryNode {
    let mut content = Vec::new();
    if let Some(meta) = meta_node {
        content.push(meta);
    }
    content.push(build_enc_node(
        enc_type,
        ciphertext,
        mediatype,
        Some(retry_count),
        None,
    ));
    if let Some(di) = device_identity {
        content.push(BinaryNode::new_with_bytes(
            TAG_DEVICE_IDENTITY,
            NodeAttrs::new(),
            di,
        ));
    }

    let mut attrs = NodeAttrs::new();
    attrs.insert("to", to);
    attrs.insert("type", msg_type);
    attrs.insert("id", id);
    attrs.insert("participant", requester_jid);
    if let Some(mode) = addressing_mode {
        attrs.insert("addressing_mode", mode);
    }

    BinaryNode::new_with_children(TAG_MESSAGE, attrs, content)
}

// ---------------------------------------------------------------------------
// <receipt> Stanza Builder
// ---------------------------------------------------------------------------

/// Builds a standard delivery receipt stanza: `<receipt id="..." to="..." [participant="..."]/>`.
pub fn build_delivery_receipt(
    id: &str,
    to: &str,
    participant: Option<&str>,
    is_peer: bool,
) -> BinaryNode {
    let mut attrs = NodeAttrs::new();
    attrs.insert("id", id);
    attrs.insert("to", to);
    if let Some(p) = participant {
        attrs.insert("participant", p);
    }
    if is_peer {
        attrs.insert("type", RECEIPT_TYPE_PEER);
    }
    BinaryNode::new_with_attrs(TAG_RECEIPT, attrs)
}

/// Builds a read receipt stanza: `<receipt id="..." to="..." type="read" [t="..."] [participant="..."]/>`.
pub fn build_read_receipt(
    id: &str,
    to: &str,
    participant: Option<&str>,
    timestamp: Option<&str>,
) -> BinaryNode {
    let mut attrs = NodeAttrs::new();
    attrs.insert("id", id);
    attrs.insert("to", to);
    attrs.insert("type", RECEIPT_TYPE_READ);
    if let Some(p) = participant {
        attrs.insert("participant", p);
    }
    if let Some(t) = timestamp {
        attrs.insert("t", t);
    }
    BinaryNode::new_with_attrs(TAG_RECEIPT, attrs)
}

/// Builds a played receipt stanza (for audio / PTT).
pub fn build_played_receipt(id: &str, to: &str, participant: Option<&str>) -> BinaryNode {
    let mut attrs = NodeAttrs::new();
    attrs.insert("id", id);
    attrs.insert("to", to);
    attrs.insert("type", RECEIPT_TYPE_PLAYED);
    if let Some(p) = participant {
        attrs.insert("participant", p);
    }
    BinaryNode::new_with_attrs(TAG_RECEIPT, attrs)
}

/// Builds a retry receipt stanza mirroring zapo's `buildReceiptNode` (retry kind):
/// `<receipt id="..." to="..." type="retry"><retry count="1" id="..." [t="..."]/></receipt>`.
pub fn build_retry_receipt(
    id: &str,
    to: &str,
    participant: Option<&str>,
    retry_count: u32,
    timestamp: Option<&str>,
) -> BinaryNode {
    let mut attrs = NodeAttrs::new();
    attrs.insert("id", id);
    attrs.insert("to", to);
    attrs.insert("type", RECEIPT_TYPE_RETRY);
    if let Some(p) = participant {
        attrs.insert("participant", p);
    }

    let count = if retry_count > 0 { retry_count } else { 1 };
    let mut retry_attrs = NodeAttrs::new();
    retry_attrs.insert("count", count.to_string());
    retry_attrs.insert("id", id);
    if let Some(t) = timestamp {
        retry_attrs.insert("t", t);
    }
    let retry_child = BinaryNode::new_with_attrs(TAG_RETRY, retry_attrs);

    BinaryNode::new_with_children(TAG_RECEIPT, attrs, vec![retry_child])
}

// ---------------------------------------------------------------------------
// <iq> Stanza Builder
// ---------------------------------------------------------------------------

/// Builds an `<iq>` query stanza (`type="get"` or `type="set"`).
pub fn build_iq_query(
    id: &str,
    to: &str,
    iq_type: &str,
    xmlns: &str,
    child: Option<BinaryNode>,
) -> BinaryNode {
    let mut attrs = NodeAttrs::new();
    attrs.insert("id", id);
    attrs.insert("to", to);
    attrs.insert("type", iq_type);
    attrs.insert("xmlns", xmlns);

    match child {
        Some(c) => BinaryNode::new_with_children(TAG_IQ, attrs, vec![c]),
        None => BinaryNode::new_with_attrs(TAG_IQ, attrs),
    }
}

/// Answers an incoming `<iq>` with a `<iq type="result"/>`, echoing id and to.
pub fn build_iq_result(iq_node: &BinaryNode) -> BinaryNode {
    let mut attrs = NodeAttrs::new();
    if let Some(id) = iq_node.attr("id") {
        attrs.insert("id", id);
    }
    let to = iq_node.attr("from").unwrap_or(HOST_DOMAIN);
    attrs.insert("to", to);
    attrs.insert("type", IQ_TYPE_RESULT);
    BinaryNode::new_with_attrs(TAG_IQ, attrs)
}

/// Answers an incoming `<iq>` with an error result `<iq type="error"><error code="..." text="..."/></iq>`.
pub fn build_iq_error(iq_node: &BinaryNode, code: u32, text: &str) -> BinaryNode {
    let mut attrs = NodeAttrs::new();
    if let Some(id) = iq_node.attr("id") {
        attrs.insert("id", id);
    }
    let to = iq_node.attr("from").unwrap_or(HOST_DOMAIN);
    attrs.insert("to", to);
    attrs.insert("type", IQ_TYPE_ERROR);

    let mut err_attrs = NodeAttrs::new();
    err_attrs.insert("code", code.to_string());
    err_attrs.insert("text", text);
    let err_node = BinaryNode::new_with_attrs(TAG_ERROR, err_attrs);

    BinaryNode::new_with_children(TAG_IQ, attrs, vec![err_node])
}

/// Builds a WhatsApp keepalive ping `<iq id="..." to="s.whatsapp.net" type="get" xmlns="w:p"><ping/></iq>`.
pub fn build_iq_ping(id: &str) -> BinaryNode {
    let ping_child = BinaryNode::new_empty("ping");
    build_iq_query(id, HOST_DOMAIN, IQ_TYPE_GET, "w:p", Some(ping_child))
}

// ---------------------------------------------------------------------------
// Protobuf Bridge (Wire Format & Message Wrapping)
// ---------------------------------------------------------------------------

/// Protobuf wire types.
pub const PROTO_WIRE_VARINT: u8 = 0;
pub const PROTO_WIRE_FIXED64: u8 = 1;
pub const PROTO_WIRE_LEN: u8 = 2;
pub const PROTO_WIRE_FIXED32: u8 = 5;

/// Lightweight Protobuf wire reader without external dependencies.
pub struct ProtoWireReader<'a> {
    data: &'a [u8],
    cursor: usize,
}

impl<'a> ProtoWireReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, cursor: 0 }
    }

    pub fn is_empty(&self) -> bool {
        self.cursor >= self.data.len()
    }

    pub fn remaining(&self) -> usize {
        self.data.len() - self.cursor
    }

    /// Read a variable-length integer (up to 10 bytes).
    pub fn read_varint(&mut self) -> Result<u64, ProtoError> {
        let mut value: u64 = 0;
        let mut shift = 0;
        let start = self.cursor;

        while self.cursor < self.data.len() && self.cursor - start < 10 {
            let byte = self.data[self.cursor];
            self.cursor += 1;
            value |= ((byte & 0x7f) as u64) << shift;
            if (byte & 0x80) == 0 {
                return Ok(value);
            }
            shift += 7;
        }

        if self.cursor - start >= 10 {
            Err(ProtoError::Custom("varint exceeds 10 bytes limit".into()))
        } else {
            Err(ProtoError::UnexpectedEof)
        }
    }

    /// Read next field tag, returning `(field_number, wire_type)`.
    pub fn read_tag(&mut self) -> Result<(u32, u8), ProtoError> {
        let tag = self.read_varint()?;
        let field_number = (tag >> 3) as u32;
        let wire_type = (tag & 0x07) as u8;
        if field_number == 0 {
            return Err(ProtoError::Custom("invalid protobuf field number 0".into()));
        }
        Ok((field_number, wire_type))
    }

    /// Read length-delimited byte slice.
    pub fn read_length_delimited(&mut self) -> Result<&'a [u8], ProtoError> {
        let len = self.read_varint()? as usize;
        if self.cursor + len <= self.data.len() {
            let slice = &self.data[self.cursor..self.cursor + len];
            self.cursor += len;
            Ok(slice)
        } else {
            Err(ProtoError::UnexpectedEof)
        }
    }

    /// Read string field.
    pub fn read_string(&mut self) -> Result<&'a str, ProtoError> {
        let bytes = self.read_length_delimited()?;
        std::str::from_utf8(bytes).map_err(|_| ProtoError::Custom("invalid utf-8 protobuf string".into()))
    }

    /// Skip field of the given wire type.
    pub fn skip_field(&mut self, wire_type: u8) -> Result<(), ProtoError> {
        match wire_type {
            PROTO_WIRE_VARINT => {
                let _ = self.read_varint()?;
                Ok(())
            }
            PROTO_WIRE_FIXED64 => {
                if self.cursor + 8 <= self.data.len() {
                    self.cursor += 8;
                    Ok(())
                } else {
                    Err(ProtoError::UnexpectedEof)
                }
            }
            PROTO_WIRE_LEN => {
                let len = self.read_varint()? as usize;
                if self.cursor + len <= self.data.len() {
                    self.cursor += len;
                    Ok(())
                } else {
                    Err(ProtoError::UnexpectedEof)
                }
            }
            PROTO_WIRE_FIXED32 => {
                if self.cursor + 4 <= self.data.len() {
                    self.cursor += 4;
                    Ok(())
                } else {
                    Err(ProtoError::UnexpectedEof)
                }
            }
            other => Err(ProtoError::Custom(format!("unsupported wire type {other}"))),
        }
    }
}

/// Lightweight Protobuf wire writer without external dependencies.
#[derive(Debug, Default)]
pub struct ProtoWireWriter {
    buffer: Vec<u8>,
}

impl ProtoWireWriter {
    pub fn new() -> Self {
        Self {
            buffer: Vec::with_capacity(128),
        }
    }

    pub fn write_varint(&mut self, mut value: u64) {
        while value >= 0x80 {
            self.buffer.push(((value & 0x7f) | 0x80) as u8);
            value >>= 7;
        }
        self.buffer.push((value & 0x7f) as u8);
    }

    pub fn write_tag(&mut self, field_number: u32, wire_type: u8) {
        let tag = ((field_number as u64) << 3) | (wire_type as u64);
        self.write_varint(tag);
    }

    pub fn write_bytes_field(&mut self, field_number: u32, bytes: &[u8]) {
        self.write_tag(field_number, PROTO_WIRE_LEN);
        self.write_varint(bytes.len() as u64);
        self.buffer.extend_from_slice(bytes);
    }

    pub fn write_string_field(&mut self, field_number: u32, text: &str) {
        self.write_bytes_field(field_number, text.as_bytes());
    }

    pub fn write_uint64_field(&mut self, field_number: u32, value: u64) {
        self.write_tag(field_number, PROTO_WIRE_VARINT);
        self.write_varint(value);
    }

    pub fn write_uint32_field(&mut self, field_number: u32, value: u32) {
        self.write_uint64_field(field_number, value as u64);
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.buffer
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.buffer
    }
}

/// Applies WhatsApp PKCS#7-style random padding (1..=16 bytes).
/// Mirrors zapo's `writeRandomPadMax16`.
pub fn pad_random_max_16(message: &[u8], seed: Option<u8>) -> Vec<u8> {
    let pad_len = match seed {
        Some(s) => ((s & 0x0f) + 1) as usize,
        None => 16,
    };
    let mut out = Vec::with_capacity(message.len() + pad_len);
    out.extend_from_slice(message);
    out.resize(message.len() + pad_len, pad_len as u8);
    out
}

/// Unpads PKCS#7 padding from decrypted payload bytes.
/// Mirrors zapo's `unpadPkcs7`.
pub fn unpad_pkcs7(bytes: &[u8]) -> Result<&[u8], ProtoError> {
    if bytes.is_empty() {
        return Err(ProtoError::Custom("unpadPkcs7 given empty bytes".into()));
    }
    let pad_len = bytes[bytes.len() - 1] as usize;
    if pad_len == 0 || pad_len > bytes.len() || pad_len > 16 {
        return Err(ProtoError::Custom(format!(
            "invalid PKCS#7 pad length {pad_len} for {} bytes",
            bytes.len()
        )));
    }
    for &b in &bytes[bytes.len() - pad_len..] {
        if b as usize != pad_len {
            return Err(ProtoError::Custom("invalid PKCS#7 padding bytes".into()));
        }
    }
    Ok(&bytes[..bytes.len() - pad_len])
}

/// Wraps raw protobuf ciphertext into an `<enc>` node and puts it into a `<message>` stanza.
pub fn wrap_proto_message_stanza(
    id: &str,
    to: &str,
    ciphertext: Vec<u8>,
    enc_type: &str,
    mediatype: Option<&str>,
) -> BinaryNode {
    let enc_node = build_enc_node(enc_type, ciphertext, mediatype, None, None);
    let mut attrs = NodeAttrs::new();
    attrs.insert("id", id);
    attrs.insert("to", to);
    attrs.insert("type", "text");
    BinaryNode::new_with_children(TAG_MESSAGE, attrs, vec![enc_node])
}

/// Extracts the `<enc>` payload (type, ciphertext) from a `<message>` stanza.
pub fn extract_enc_payload(node: &BinaryNode) -> Option<(&str, &[u8])> {
    if node.tag == TAG_ENC {
        let enc_type = node.attr("type")?;
        let bytes = node.bytes()?;
        return Some((enc_type, bytes));
    }
    if let Some(enc_node) = node.child(TAG_ENC) {
        let enc_type = enc_node.attr("type")?;
        let bytes = enc_node.bytes()?;
        return Some((enc_type, bytes));
    }
    None
}

// ---------------------------------------------------------------------------
// Unit Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_button_addon_nodes() {
        let list_node = build_button_addon_node(ButtonAddonKind::List);
        assert_eq!(list_node.tag, TAG_BIZ);
        let list_child = list_node.child(TAG_LIST).expect("expected list child");
        assert_eq!(list_child.attr("type"), Some("product_list"));
        assert_eq!(list_child.attr("v"), Some("2"));

        let inter_node = build_button_addon_node(ButtonAddonKind::Interactive);
        assert_eq!(inter_node.tag, TAG_BIZ);
        let inter_child = inter_node
            .child(TAG_INTERACTIVE)
            .expect("expected interactive child");
        assert_eq!(inter_child.attr("type"), Some(TAG_NATIVE_FLOW));
        assert_eq!(inter_child.attr("v"), Some("1"));
        let flow_child = inter_child
            .child(TAG_NATIVE_FLOW)
            .expect("expected native_flow child");
        assert_eq!(flow_child.attr("name"), Some("mixed"));
        assert_eq!(flow_child.attr("v"), Some("9"));

        let pix_node = build_button_addon_node(ButtonAddonKind::PaymentInfo);
        let pix_inter = pix_node.child(TAG_INTERACTIVE).unwrap();
        let pix_flow = pix_inter.child(TAG_NATIVE_FLOW).unwrap();
        assert_eq!(pix_flow.attr("name"), Some("payment_info"));
        assert_eq!(pix_flow.attr("v"), None);

        let order_node = build_button_addon_node(ButtonAddonKind::OrderDetails);
        let order_inter = order_node.child(TAG_INTERACTIVE).unwrap();
        let order_flow = order_inter.child(TAG_NATIVE_FLOW).unwrap();
        assert_eq!(order_flow.attr("name"), Some("order_details"));
        assert_eq!(order_flow.attr("v"), None);
    }

    #[test]
    fn test_enc_node_builder() {
        let ciphertext = vec![1, 2, 3, 4, 5];
        let enc_node = build_enc_node(
            ENC_TYPE_MSG,
            ciphertext.clone(),
            Some("image"),
            Some(2),
            Some("error"),
        );
        assert_eq!(enc_node.tag, TAG_ENC);
        assert_eq!(enc_node.attr("v"), Some("2"));
        assert_eq!(enc_node.attr("type"), Some("msg"));
        assert_eq!(enc_node.attr("mediatype"), Some("image"));
        assert_eq!(enc_node.attr("count"), Some("2"));
        assert_eq!(enc_node.attr("decrypt-fail"), Some("error"));
        assert_eq!(enc_node.bytes(), Some(ciphertext.as_slice()));
    }

    #[test]
    fn test_message_stanza_builders() {
        let p = EncryptedParticipant::new("5511999998888@s.whatsapp.net", "msg", vec![10, 20]);
        let attrs = MessageAttrs::new("5511999998888@s.whatsapp.net", "text");
        let msg_node = build_direct_message_fanout_node(
            attrs,
            vec![p.clone()],
            vec![],
            Some(vec![99]),
            vec![],
            None,
        );
        assert_eq!(msg_node.tag, TAG_MESSAGE);
        assert_eq!(msg_node.attr("to"), Some("5511999998888@s.whatsapp.net"));
        assert_eq!(msg_node.attr("type"), Some("text"));
        let participants = msg_node.child(TAG_PARTICIPANTS).unwrap();
        let to_child = participants.child(TAG_TO).unwrap();
        assert_eq!(to_child.attr("jid"), Some("5511999998888@s.whatsapp.net"));
        let enc_child = to_child.child(TAG_ENC).unwrap();
        assert_eq!(enc_child.bytes(), Some(&[10, 20][..]));

        // Group sender key message
        let g_attrs = MessageAttrs::new("120363042123456789@g.us", "text");
        let group_node = build_group_sender_key_message_node(
            g_attrs,
            vec![1, 2, 3],
            vec![p],
            vec![],
            None,
            None,
        );
        assert_eq!(group_node.tag, TAG_MESSAGE);
        let group_enc = group_node.child(TAG_ENC).unwrap();
        assert_eq!(group_enc.attr("type"), Some("skmsg"));
        assert_eq!(group_enc.bytes(), Some(&[1, 2, 3][..]));
    }

    #[test]
    fn test_receipt_builders() {
        let delivery = build_delivery_receipt(
            "msg-123",
            "5511999998888@s.whatsapp.net",
            Some("participant@s.whatsapp.net"),
            false,
        );
        assert_eq!(delivery.tag, TAG_RECEIPT);
        assert_eq!(delivery.attr("id"), Some("msg-123"));
        assert_eq!(delivery.attr("to"), Some("5511999998888@s.whatsapp.net"));
        assert_eq!(
            delivery.attr("participant"),
            Some("participant@s.whatsapp.net")
        );

        let read = build_read_receipt("msg-456", "peer@s.whatsapp.net", None, Some("1690000000"));
        assert_eq!(read.attr("type"), Some("read"));
        assert_eq!(read.attr("t"), Some("1690000000"));

        let retry = build_retry_receipt("msg-789", "peer@s.whatsapp.net", None, 3, None);
        assert_eq!(retry.attr("type"), Some("retry"));
        let retry_child = retry.child(TAG_RETRY).unwrap();
        assert_eq!(retry_child.attr("count"), Some("3"));
        assert_eq!(retry_child.attr("id"), Some("msg-789"));
    }

    #[test]
    fn test_iq_builders() {
        let ping = build_iq_ping("ping-1");
        assert_eq!(ping.tag, TAG_IQ);
        assert_eq!(ping.attr("id"), Some("ping-1"));
        assert_eq!(ping.attr("xmlns"), Some("w:p"));
        assert_eq!(ping.attr("type"), Some("get"));

        let result = build_iq_result(&ping);
        assert_eq!(result.attr("id"), Some("ping-1"));
        assert_eq!(result.attr("type"), Some("result"));

        let err = build_iq_error(&ping, 404, "not-found");
        assert_eq!(err.attr("id"), Some("ping-1"));
        assert_eq!(err.attr("type"), Some("error"));
        let err_child = err.child(TAG_ERROR).unwrap();
        assert_eq!(err_child.attr("code"), Some("404"));
        assert_eq!(err_child.attr("text"), Some("not-found"));
    }

    #[test]
    fn test_proto_wire_reader_writer() {
        let mut writer = ProtoWireWriter::new();
        writer.write_uint64_field(1, 1234567890);
        writer.write_string_field(2, "hello protobuf");
        writer.write_bytes_field(3, &[0xde, 0xad, 0xbe, 0xef]);
        let wire_bytes = writer.into_bytes();

        let mut reader = ProtoWireReader::new(&wire_bytes);

        let (fn1, wt1) = reader.read_tag().unwrap();
        assert_eq!(fn1, 1);
        assert_eq!(wt1, PROTO_WIRE_VARINT);
        assert_eq!(reader.read_varint().unwrap(), 1234567890);

        let (fn2, wt2) = reader.read_tag().unwrap();
        assert_eq!(fn2, 2);
        assert_eq!(wt2, PROTO_WIRE_LEN);
        assert_eq!(reader.read_string().unwrap(), "hello protobuf");

        let (fn3, wt3) = reader.read_tag().unwrap();
        assert_eq!(fn3, 3);
        assert_eq!(wt3, PROTO_WIRE_LEN);
        assert_eq!(reader.read_length_delimited().unwrap(), &[0xde, 0xad, 0xbe, 0xef]);

        assert!(reader.is_empty());
    }

    #[test]
    fn test_pkcs7_padding_roundtrip() {
        let data = b"WhatsApp Message Content Payload";
        for seed in 0..=32 {
            let padded = pad_random_max_16(data, Some(seed));
            assert!(padded.len() > data.len());
            assert!(padded.len() <= data.len() + 16);
            let unpadded = unpad_pkcs7(&padded).unwrap();
            assert_eq!(unpadded, data);
        }
    }

    #[test]
    fn test_wrap_and_extract_proto_message() {
        let ciphertext = vec![11, 22, 33, 44];
        let stanza = wrap_proto_message_stanza(
            "msg-001",
            "123@s.whatsapp.net",
            ciphertext.clone(),
            "msg",
            Some("text"),
        );
        let extracted = extract_enc_payload(&stanza);
        assert!(extracted.is_some());
        let (enc_type, extracted_bytes) = extracted.unwrap();
        assert_eq!(enc_type, "msg");
        assert_eq!(extracted_bytes, ciphertext.as_slice());
    }
}

