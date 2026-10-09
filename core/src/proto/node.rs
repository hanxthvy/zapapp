// [xihanzu-NR]
//! WhatsApp Binary XML Node (BinaryNode) struct and codec.
//! Mirrors zapo's BinaryNode and src/transport/binary/ (encoder.ts, decoder.ts, constants.ts).

use std::collections::HashMap;
use std::fmt;
use std::ops::{Deref, Index};

use crate::proto::tokens::{
    classify_packed_string, find_token, get_dict_token, get_single_byte_token, PackedType,
    TokenLookup, BINARY_20, BINARY_32, BINARY_8, DICTIONARY_0, DICTIONARY_3, HEX_8, HEX_ALPHABET,
    HOSTED_LID_SERVER, HOSTED_SERVER, HOST_DOMAIN, JID_FB, JID_INTEROP, JID_PAIR, JID_U,
    JID_U_DOMAIN_TYPE_HOSTED, JID_U_DOMAIN_TYPE_HOSTED_LID, JID_U_DOMAIN_TYPE_HOSTED_MASK,
    JID_U_DOMAIN_TYPE_LID, JID_U_DOMAIN_TYPE_LID_MASK, JID_U_DOMAIN_TYPE_PN, KNOWN_JID_SERVERS,
    LID_SERVER, LIST_16, LIST_8, LIST_EMPTY, NIBBLE_8, NIBBLE_ALPHABET,
    STREAM_END,
};

/// Errors encountered while encoding or decoding WAP binary XML nodes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtoError {
    UnexpectedEof,
    InvalidListType(u8),
    EmptyList,
    InvalidTag,
    InvalidAttribute,
    InvalidToken(u8),
    InvalidDictionaryToken(u8, u8),
    InvalidBinaryToken(u8),
    CannotNibbleEncode(u8),
    InvalidPackedLength(u8),
    StreamEndStanza,
    DecompressionFailed(String),
    Custom(String),
}

impl fmt::Display for ProtoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnexpectedEof => write!(f, "unexpected end of binary node payload"),
            Self::InvalidListType(t) => write!(f, "invalid node list type {t}"),
            Self::EmptyList => write!(f, "invalid binary node: empty list"),
            Self::InvalidTag => write!(f, "invalid binary node tag"),
            Self::InvalidAttribute => write!(f, "invalid binary node attribute entry"),
            Self::InvalidToken(t) => write!(f, "unsupported string token {t}"),
            Self::InvalidDictionaryToken(d, idx) => {
                write!(f, "invalid dictionary token {d}:{idx}")
            }
            Self::InvalidBinaryToken(t) => write!(f, "invalid binary token {t}"),
            Self::CannotNibbleEncode(c) => write!(f, "cannot nibble encode char code {c}"),
            Self::InvalidPackedLength(b) => {
                write!(f, "invalid packed length byte 0x{b:02x}")
            }
            Self::StreamEndStanza => write!(f, "stream end stanza is not a binary node"),
            Self::DecompressionFailed(msg) => write!(f, "failed to decompress stanza: {msg}"),
            Self::Custom(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for ProtoError {}

/// Order-preserving attribute map for `BinaryNode`.
/// Provides key-based lookup while keeping exact insertion order for round-trip fidelity.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NodeAttrs {
    entries: Vec<(String, String)>,
}

impl NodeAttrs {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            entries: Vec::with_capacity(capacity),
        }
    }

    pub fn insert(&mut self, key: impl Into<String>, value: impl Into<String>) {
        let k = key.into();
        let v = value.into();
        if let Some(pos) = self.entries.iter().position(|(ek, _)| ek == &k) {
            self.entries[pos].1 = v;
        } else {
            self.entries.push((k, v));
        }
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.entries.iter().any(|(k, _)| k == key)
    }

    pub fn remove(&mut self, key: &str) -> Option<String> {
        if let Some(pos) = self.entries.iter().position(|(k, _)| k == key) {
            Some(self.entries.remove(pos).1)
        } else {
            None
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.entries
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|(k, _)| k.as_str())
    }

    pub fn values(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|(_, v)| v.as_str())
    }

    pub fn as_slice(&self) -> &[(String, String)] {
        &self.entries
    }
}

impl Deref for NodeAttrs {
    type Target = [(String, String)];
    fn deref(&self) -> &Self::Target {
        &self.entries
    }
}

impl Index<&str> for NodeAttrs {
    type Output = str;
    fn index(&self, key: &str) -> &Self::Output {
        self.get(key)
            .unwrap_or_else(|| panic!("Attribute '{key}' not found"))
    }
}

impl FromIterator<(String, String)> for NodeAttrs {
    fn from_iter<T: IntoIterator<Item = (String, String)>>(iter: T) -> Self {
        Self {
            entries: iter.into_iter().collect(),
        }
    }
}

impl From<Vec<(String, String)>> for NodeAttrs {
    fn from(entries: Vec<(String, String)>) -> Self {
        Self { entries }
    }
}

impl From<HashMap<String, String>> for NodeAttrs {
    fn from(map: HashMap<String, String>) -> Self {
        Self {
            entries: map.into_iter().collect(),
        }
    }
}

impl From<&[(&str, &str)]> for NodeAttrs {
    fn from(pairs: &[(&str, &str)]) -> Self {
        Self {
            entries: pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        }
    }
}

impl<'a> IntoIterator for &'a NodeAttrs {
    type Item = (&'a str, &'a str);
    type IntoIter = Box<dyn Iterator<Item = (&'a str, &'a str)> + 'a>;

    fn into_iter(self) -> Self::IntoIter {
        Box::new(self.iter())
    }
}

/// Content of a `BinaryNode`.
/// Mirrors zapo's `Uint8Array | string | readonly BinaryNode[]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BinaryNodeContent {
    Bytes(Vec<u8>),
    String(String),
    Nodes(Vec<BinaryNode>),
}

impl BinaryNodeContent {
    pub fn as_bytes(&self) -> Option<&[u8]> {
        match self {
            Self::Bytes(b) => Some(b.as_slice()),
            Self::String(s) => Some(s.as_bytes()),
            Self::Nodes(_) => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(s) => Some(s.as_str()),
            Self::Bytes(b) => std::str::from_utf8(b).ok(),
            Self::Nodes(_) => None,
        }
    }

    pub fn as_nodes(&self) -> Option<&[BinaryNode]> {
        match self {
            Self::Nodes(nodes) => Some(nodes.as_slice()),
            _ => None,
        }
    }

    pub fn as_nodes_mut(&mut self) -> Option<&mut Vec<BinaryNode>> {
        match self {
            Self::Nodes(nodes) => Some(nodes),
            _ => None,
        }
    }
}

/// WhatsApp Binary XML Node.
/// Mirrors zapo's `BinaryNode` ({ tag: string, attrs: Record<string, string>, content?: ... }).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinaryNode {
    pub tag: String,
    pub attrs: NodeAttrs,
    pub content: Option<BinaryNodeContent>,
}

impl BinaryNode {
    /// Create a new `BinaryNode` with tag, attributes, and optional content.
    pub fn new(
        tag: impl Into<String>,
        attrs: impl Into<NodeAttrs>,
        content: Option<BinaryNodeContent>,
    ) -> Self {
        Self {
            tag: tag.into(),
            attrs: attrs.into(),
            content,
        }
    }

    /// Create an empty `BinaryNode` with only a tag.
    pub fn new_empty(tag: impl Into<String>) -> Self {
        Self {
            tag: tag.into(),
            attrs: NodeAttrs::new(),
            content: None,
        }
    }

    /// Create a `BinaryNode` with tag and attributes.
    pub fn new_with_attrs(tag: impl Into<String>, attrs: impl Into<NodeAttrs>) -> Self {
        Self {
            tag: tag.into(),
            attrs: attrs.into(),
            content: None,
        }
    }

    /// Create a `BinaryNode` with child nodes.
    pub fn new_with_children(
        tag: impl Into<String>,
        attrs: impl Into<NodeAttrs>,
        children: Vec<BinaryNode>,
    ) -> Self {
        Self {
            tag: tag.into(),
            attrs: attrs.into(),
            content: Some(BinaryNodeContent::Nodes(children)),
        }
    }

    /// Create a `BinaryNode` with binary bytes content.
    pub fn new_with_bytes(
        tag: impl Into<String>,
        attrs: impl Into<NodeAttrs>,
        bytes: Vec<u8>,
    ) -> Self {
        Self {
            tag: tag.into(),
            attrs: attrs.into(),
            content: Some(BinaryNodeContent::Bytes(bytes)),
        }
    }

    /// Create a `BinaryNode` with string text content.
    pub fn new_with_string(
        tag: impl Into<String>,
        attrs: impl Into<NodeAttrs>,
        text: impl Into<String>,
    ) -> Self {
        Self {
            tag: tag.into(),
            attrs: attrs.into(),
            content: Some(BinaryNodeContent::String(text.into())),
        }
    }

    /// Look up attribute value by key.
    pub fn attr(&self, key: &str) -> Option<&str> {
        self.attrs.get(key)
    }

    /// Alias for `attr`.
    pub fn get_attr(&self, key: &str) -> Option<&str> {
        self.attrs.get(key)
    }

    /// Set an attribute.
    pub fn set_attr(&mut self, key: impl Into<String>, value: impl Into<String>) {
        self.attrs.insert(key, value);
    }

    /// Find first child node with the given tag.
    pub fn child(&self, tag: &str) -> Option<&BinaryNode> {
        self.children().and_then(|c| c.iter().find(|n| n.tag == tag))
    }

    /// Find first mutable child node with the given tag.
    pub fn child_mut(&mut self, tag: &str) -> Option<&mut BinaryNode> {
        self.children_mut()
            .and_then(|c| c.iter_mut().find(|n| n.tag == tag))
    }

    /// Get slice of child nodes if content is `Nodes`.
    pub fn children(&self) -> Option<&[BinaryNode]> {
        self.content.as_ref().and_then(|c| c.as_nodes())
    }

    /// Get mutable reference to child nodes if content is `Nodes`.
    pub fn children_mut(&mut self) -> Option<&mut Vec<BinaryNode>> {
        self.content.as_mut().and_then(|c| c.as_nodes_mut())
    }

    /// Get content bytes (from Bytes or String).
    pub fn bytes(&self) -> Option<&[u8]> {
        self.content.as_ref().and_then(|c| c.as_bytes())
    }

    /// Get content string (from String or UTF-8 Bytes).
    pub fn string(&self) -> Option<&str> {
        self.content.as_ref().and_then(|c| c.as_str())
    }

    /// Append a child node. If content is None, initializes it as Nodes.
    pub fn push_child(&mut self, child: BinaryNode) {
        match &mut self.content {
            Some(BinaryNodeContent::Nodes(nodes)) => nodes.push(child),
            None => self.content = Some(BinaryNodeContent::Nodes(vec![child])),
            _ => panic!("Cannot append child node to non-Nodes content"),
        }
    }

    /// Encode this `BinaryNode` to raw WhatsApp binary representation.
    pub fn encode(&self) -> Vec<u8> {
        encode_binary_node(self)
    }

    /// Encode this `BinaryNode` as a transport stanza (prefixed with 0x00 flag byte).
    pub fn encode_stanza(&self) -> Vec<u8> {
        encode_binary_node_stanza(self)
    }

    /// Decode raw WhatsApp binary representation into a `BinaryNode`.
    pub fn decode(data: &[u8]) -> Result<Self, ProtoError> {
        decode_binary_node(data)
    }

    /// Decode transport stanza (first byte is flag).
    pub fn decode_stanza(stanza: &[u8]) -> Result<Self, ProtoError> {
        decode_binary_node_stanza(stanza)
    }
}

// ---------------------------------------------------------------------------
// ByteWriter and ByteReader
// ---------------------------------------------------------------------------

pub struct ByteWriter {
    buffer: Vec<u8>,
}

impl ByteWriter {
    pub fn new() -> Self {
        Self {
            buffer: Vec::with_capacity(256),
        }
    }

    pub fn with_capacity(cap: usize) -> Self {
        Self {
            buffer: Vec::with_capacity(cap),
        }
    }

    pub fn write_u8(&mut self, val: u8) {
        self.buffer.push(val);
    }

    pub fn write_u16_be(&mut self, val: u16) {
        self.buffer.extend_from_slice(&val.to_be_bytes());
    }

    pub fn write_u32_be(&mut self, val: u32) {
        self.buffer.extend_from_slice(&val.to_be_bytes());
    }

    pub fn write_bytes(&mut self, bytes: &[u8]) {
        self.buffer.extend_from_slice(bytes);
    }

    pub fn reserve_u8(&mut self) -> usize {
        let pos = self.buffer.len();
        self.buffer.push(0);
        pos
    }

    pub fn patch_u8(&mut self, pos: usize, val: u8) {
        self.buffer[pos] = val;
    }

    pub fn to_vec(self) -> Vec<u8> {
        self.buffer
    }
}

pub struct ByteReader<'a> {
    data: &'a [u8],
    offset: usize,
}

impl<'a> ByteReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, offset: 0 }
    }

    pub fn read_u8(&mut self) -> Result<u8, ProtoError> {
        if self.offset < self.data.len() {
            let b = self.data[self.offset];
            self.offset += 1;
            Ok(b)
        } else {
            Err(ProtoError::UnexpectedEof)
        }
    }

    pub fn read_u16_be(&mut self) -> Result<u16, ProtoError> {
        if self.offset + 2 <= self.data.len() {
            let val = u16::from_be_bytes([self.data[self.offset], self.data[self.offset + 1]]);
            self.offset += 2;
            Ok(val)
        } else {
            Err(ProtoError::UnexpectedEof)
        }
    }

    pub fn read_u32_be(&mut self) -> Result<u32, ProtoError> {
        if self.offset + 4 <= self.data.len() {
            let val = u32::from_be_bytes([
                self.data[self.offset],
                self.data[self.offset + 1],
                self.data[self.offset + 2],
                self.data[self.offset + 3],
            ]);
            self.offset += 4;
            Ok(val)
        } else {
            Err(ProtoError::UnexpectedEof)
        }
    }

    pub fn read_bytes(&mut self, len: usize) -> Result<&'a [u8], ProtoError> {
        if self.offset + len <= self.data.len() {
            let slice = &self.data[self.offset..self.offset + len];
            self.offset += len;
            Ok(slice)
        } else {
            Err(ProtoError::UnexpectedEof)
        }
    }

    pub fn remaining(&self) -> usize {
        self.data.len() - self.offset
    }

    pub fn is_empty(&self) -> bool {
        self.offset >= self.data.len()
    }
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

fn to_nibble(ch: u8, packed_type: u8) -> Result<u8, ProtoError> {
    if ch.is_ascii_digit() {
        return Ok(ch - b'0');
    }
    if packed_type == NIBBLE_8 {
        if ch == b'-' {
            return Ok(10);
        }
        if ch == b'.' {
            return Ok(11);
        }
    }
    if packed_type == HEX_8 && (b'A'..=b'F').contains(&ch) {
        return Ok(ch - b'A' + 10);
    }
    Err(ProtoError::CannotNibbleEncode(ch))
}

fn write_packed_string(
    value: &str,
    packed_type: u8,
    writer: &mut ByteWriter,
) -> Result<(), ProtoError> {
    let bytes = value.as_bytes();
    let odd = bytes.len() % 2 == 1;
    writer.write_u8(packed_type);
    let mut length = ((bytes.len() + 1) / 2) as u8;
    if odd {
        length |= 0x80;
    }
    writer.write_u8(length);

    let mut i = 0;
    while i < bytes.len() {
        let high = to_nibble(bytes[i], packed_type)?;
        let low = if i + 1 < bytes.len() {
            to_nibble(bytes[i + 1], packed_type)?
        } else {
            0x0f
        };
        writer.write_u8((high << 4) | low);
        i += 2;
    }
    Ok(())
}

fn write_binary_length(length: usize, writer: &mut ByteWriter) {
    if length < 256 {
        writer.write_u8(BINARY_8);
        writer.write_u8(length as u8);
    } else if length < (1 << 20) {
        writer.write_u8(BINARY_20);
        writer.write_u8(((length >> 16) & 0xff) as u8);
        writer.write_u8(((length >> 8) & 0xff) as u8);
        writer.write_u8((length & 0xff) as u8);
    } else {
        writer.write_u8(BINARY_32);
        writer.write_u32_be(length as u32);
    }
}

fn write_utf8_with_length(value: &str, writer: &mut ByteWriter) {
    let bytes = value.as_bytes();
    if value.len() < 86 {
        writer.write_u8(BINARY_8);
        writer.write_u8(bytes.len() as u8);
        writer.write_bytes(bytes);
    } else {
        write_binary_length(bytes.len(), writer);
        writer.write_bytes(bytes);
    }
}

fn write_string(value: &str, writer: &mut ByteWriter) {
    if let Some(token) = find_token(value) {
        match token {
            TokenLookup::SingleByte(byte) => {
                writer.write_u8(byte);
            }
            TokenLookup::Dict(dict_idx, token_idx) => {
                writer.write_u8(DICTIONARY_0 + dict_idx);
                writer.write_u8(token_idx);
            }
        }
        return;
    }

    match classify_packed_string(value) {
        PackedType::Nibble => {
            if write_packed_string(value, NIBBLE_8, writer).is_ok() {
                return;
            }
        }
        PackedType::Hex => {
            if write_packed_string(value, HEX_8, writer).is_ok() {
                return;
            }
        }
        PackedType::None => {}
    }

    write_utf8_with_length(value, writer);
}

fn match_known_server(server: &str) -> &str {
    for &known in &KNOWN_JID_SERVERS {
        if known == server {
            return known;
        }
    }
    server
}

fn try_write_jid(value: &str, writer: &mut ByteWriter) -> bool {
    let at_index = match value.find('@') {
        Some(idx) => idx,
        None => return false,
    };
    if at_index == 0 || at_index == value.len() - 1 {
        return false;
    }
    if value[at_index + 1..].contains('@') {
        return false;
    }

    let mut user_end = at_index;
    let mut device: u32 = 0;
    if let Some(colon_idx) = value[..at_index].find(':') {
        if colon_idx == at_index - 1 {
            return false;
        }
        for b in value[colon_idx + 1..at_index].bytes() {
            if !b.is_ascii_digit() {
                return false;
            }
            device = device * 10 + (b - b'0') as u32;
            if device > 255 {
                return false;
            }
        }
        user_end = colon_idx;
    }

    let server_part = &value[at_index + 1..];
    let server = match_known_server(server_part);

    let mut domain_type: i16 = -1;
    if server == LID_SERVER {
        domain_type = JID_U_DOMAIN_TYPE_LID as i16;
    } else if server == HOSTED_LID_SERVER {
        domain_type = JID_U_DOMAIN_TYPE_HOSTED_LID as i16;
    } else if server == HOST_DOMAIN {
        domain_type = JID_U_DOMAIN_TYPE_PN as i16;
    } else if server == HOSTED_SERVER {
        domain_type = JID_U_DOMAIN_TYPE_HOSTED as i16;
    }

    if domain_type != -1 && device != 0 && user_end > 0 {
        writer.write_u8(JID_U);
        writer.write_u8(domain_type as u8);
        writer.write_u8(device as u8);
        write_string(&value[..user_end], writer);
        return true;
    }

    writer.write_u8(JID_PAIR);
    if user_end == 0 {
        writer.write_u8(LIST_EMPTY);
    } else {
        write_string(&value[..user_end], writer);
    }
    write_string(server, writer);
    return true;
}

fn write_list_size(size: usize, writer: &mut ByteWriter) {
    if size < 256 {
        writer.write_u8(LIST_8);
        writer.write_u8(size as u8);
    } else {
        writer.write_u8(LIST_16);
        writer.write_u16_be(size as u16);
    }
}

fn write_node_internal(node: &BinaryNode, writer: &mut ByteWriter) {
    let attrs_len = node.attrs.len();
    let has_content = node.content.is_some();
    let list_size = 1 + attrs_len * 2 + if has_content { 1 } else { 0 };

    write_list_size(list_size, writer);
    write_string(&node.tag, writer);

    for (key, value) in node.attrs.iter() {
        write_string(key, writer);
        if !try_write_jid(value, writer) {
            write_string(value, writer);
        }
    }

    match &node.content {
        None => {}
        Some(BinaryNodeContent::String(s)) => {
            write_utf8_with_length(s, writer);
        }
        Some(BinaryNodeContent::Bytes(b)) => {
            write_binary_length(b.len(), writer);
            writer.write_bytes(b);
        }
        Some(BinaryNodeContent::Nodes(children)) => {
            write_list_size(children.len(), writer);
            for child in children {
                write_node_internal(child, writer);
            }
        }
    }
}

/// Encodes a `BinaryNode` into raw WhatsApp binary bytes.
pub fn encode_binary_node(node: &BinaryNode) -> Vec<u8> {
    let mut writer = ByteWriter::new();
    write_node_internal(node, &mut writer);
    writer.to_vec()
}

/// Encodes a `BinaryNode` as a transport stanza (prefixed with 0x00 flag byte).
pub fn encode_binary_node_stanza(node: &BinaryNode) -> Vec<u8> {
    let mut writer = ByteWriter::new();
    writer.write_u8(0x00);
    write_node_internal(node, &mut writer);
    writer.to_vec()
}

// ---------------------------------------------------------------------------
// Decoding helpers
// ---------------------------------------------------------------------------

fn parse_packed(reader: &mut ByteReader, alphabet: &[char; 16]) -> Result<String, ProtoError> {
    let length_byte = reader.read_u8()?;
    let odd = (length_byte & 0x80) != 0;
    let byte_count = (length_byte & 0x7f) as usize;
    let out_length = byte_count * 2 - if odd { 1 } else { 0 };

    let mut out = String::with_capacity(out_length);
    for _ in 0..byte_count {
        let b = reader.read_u8()?;
        let high = ((b >> 4) & 0x0f) as usize;
        let low = (b & 0x0f) as usize;
        out.push(alphabet[high]);
        out.push(alphabet[low]);
    }
    if odd {
        out.truncate(out_length);
    }
    Ok(out)
}

fn read_binary<'a>(reader: &mut ByteReader<'a>, token: u8) -> Result<&'a [u8], ProtoError> {
    match token {
        BINARY_8 => {
            let len = reader.read_u8()? as usize;
            reader.read_bytes(len)
        }
        BINARY_20 => {
            let b0 = reader.read_u8()? as usize;
            let b1 = reader.read_u8()? as usize;
            let b2 = reader.read_u8()? as usize;
            let len = ((b0 & 0x0f) << 16) | (b1 << 8) | b2;
            reader.read_bytes(len)
        }
        BINARY_32 => {
            let len = reader.read_u32_be()? as usize;
            reader.read_bytes(len)
        }
        _ => Err(ProtoError::InvalidBinaryToken(token)),
    }
}

fn decode_token_string(token: u8, reader: &mut ByteReader) -> Result<String, ProtoError> {
    if let Some(s) = get_single_byte_token(token as usize) {
        return Ok(s.to_string());
    }

    if (DICTIONARY_0..=DICTIONARY_3).contains(&token) {
        let dict_idx = (token - DICTIONARY_0) as usize;
        let idx = reader.read_u8()? as usize;
        if let Some(token_str) = get_dict_token(dict_idx, idx) {
            return Ok(token_str.to_string());
        }
        return Err(ProtoError::InvalidDictionaryToken(token, idx as u8));
    }

    if token == NIBBLE_8 {
        return parse_packed(reader, &NIBBLE_ALPHABET);
    }

    if token == HEX_8 {
        return parse_packed(reader, &HEX_ALPHABET);
    }

    if token == BINARY_8 || token == BINARY_20 || token == BINARY_32 {
        let bytes = read_binary(reader, token)?;
        return std::str::from_utf8(bytes)
            .map(|s| s.to_string())
            .map_err(|_| ProtoError::Custom("invalid utf-8 binary string".into()));
    }

    Err(ProtoError::InvalidToken(token))
}

fn decode_jid_pair(reader: &mut ByteReader) -> Result<String, ProtoError> {
    let user_token = reader.read_u8()?;
    let user = if user_token == LIST_EMPTY {
        String::new()
    } else {
        decode_token_string(user_token, reader)?
    };
    let server_token = reader.read_u8()?;
    let server = decode_token_string(server_token, reader)?;
    if user.is_empty() {
        Ok(server)
    } else {
        Ok(format!("{user}@{server}"))
    }
}

fn decode_jid_u(reader: &mut ByteReader) -> Result<String, ProtoError> {
    let domain_type = reader.read_u8()?;
    let device = reader.read_u8()?;
    let user_token = reader.read_u8()?;
    let user = decode_token_string(user_token, reader)?;

    let mut domain = HOST_DOMAIN;
    if domain_type == JID_U_DOMAIN_TYPE_LID {
        domain = LID_SERVER;
    } else if domain_type == JID_U_DOMAIN_TYPE_HOSTED_LID {
        domain = HOSTED_LID_SERVER;
    } else if (domain_type & JID_U_DOMAIN_TYPE_HOSTED_MASK) != 0
        && (domain_type & JID_U_DOMAIN_TYPE_LID_MASK) == 0
    {
        domain = HOSTED_SERVER;
    }

    if device > 0 {
        Ok(format!("{user}:{device}@{domain}"))
    } else {
        Ok(format!("{user}@{domain}"))
    }
}

fn decode_jid_interop(reader: &mut ByteReader) -> Result<String, ProtoError> {
    let user_token = reader.read_u8()?;
    let user = decode_token_string(user_token, reader)?;
    let device = reader.read_u16_be()?;
    let integrator = reader.read_u16_be()?;
    let dummy_token = reader.read_u8()?;
    let _ = decode_token_string(dummy_token, reader)?;
    Ok(format!("{integrator}-{user}:{device}@interop"))
}

fn decode_jid_fb(reader: &mut ByteReader) -> Result<String, ProtoError> {
    let user_token = reader.read_u8()?;
    let user = decode_token_string(user_token, reader)?;
    let device = reader.read_u16_be()?;
    let dummy_token = reader.read_u8()?;
    let _ = decode_token_string(dummy_token, reader)?;
    Ok(format!("{user}:{device}@msgr"))
}

enum DecodedValue {
    None,
    Str(String),
    Bytes(Vec<u8>),
}

fn decode_value(
    reader: &mut ByteReader,
    token: u8,
    for_attr: bool,
) -> Result<DecodedValue, ProtoError> {
    if token == LIST_EMPTY {
        return Ok(DecodedValue::None);
    }
    if token == JID_PAIR {
        return decode_jid_pair(reader).map(DecodedValue::Str);
    }
    if token == JID_U {
        return decode_jid_u(reader).map(DecodedValue::Str);
    }
    if token == JID_INTEROP {
        return decode_jid_interop(reader).map(DecodedValue::Str);
    }
    if token == JID_FB {
        return decode_jid_fb(reader).map(DecodedValue::Str);
    }

    if token == BINARY_8 || token == BINARY_20 || token == BINARY_32 {
        let binary = read_binary(reader, token)?;
        if for_attr {
            let s = std::str::from_utf8(binary)
                .map_err(|_| ProtoError::Custom("invalid utf-8 attribute value".into()))?;
            return Ok(DecodedValue::Str(s.to_string()));
        } else {
            return Ok(DecodedValue::Bytes(binary.to_vec()));
        }
    }

    let s = decode_token_string(token, reader)?;
    Ok(DecodedValue::Str(s))
}

fn decode_node_internal(reader: &mut ByteReader) -> Result<BinaryNode, ProtoError> {
    let list_type = reader.read_u8()?;
    let list_size = match list_type {
        LIST_8 => reader.read_u8()? as usize,
        LIST_16 => reader.read_u16_be()? as usize,
        other => return Err(ProtoError::InvalidListType(other)),
    };

    if list_size == 0 {
        return Err(ProtoError::EmptyList);
    }

    let tag_token = reader.read_u8()?;
    let tag = match decode_value(reader, tag_token, true)? {
        DecodedValue::Str(s) if !s.is_empty() => s,
        _ => return Err(ProtoError::InvalidTag),
    };

    let mut attrs = NodeAttrs::with_capacity((list_size - 1) / 2);
    let mut remaining = list_size - 1;

    while remaining > 1 {
        let key_token = reader.read_u8()?;
        let key = match decode_value(reader, key_token, true)? {
            DecodedValue::Str(s) => s,
            _ => return Err(ProtoError::InvalidAttribute),
        };
        let val_token = reader.read_u8()?;
        let val = match decode_value(reader, val_token, true)? {
            DecodedValue::Str(s) => s,
            _ => return Err(ProtoError::InvalidAttribute),
        };
        attrs.insert(key, val);
        remaining -= 2;
    }

    let mut content: Option<BinaryNodeContent> = None;
    if remaining == 1 {
        let content_token = reader.read_u8()?;
        if content_token == LIST_EMPTY {
            content = None;
        } else if content_token == LIST_8 || content_token == LIST_16 {
            let children_count = if content_token == LIST_8 {
                reader.read_u8()? as usize
            } else {
                reader.read_u16_be()? as usize
            };
            let mut children = Vec::with_capacity(children_count);
            for _ in 0..children_count {
                children.push(decode_node_internal(reader)?);
            }
            content = Some(BinaryNodeContent::Nodes(children));
        } else {
            match decode_value(reader, content_token, false)? {
                DecodedValue::None => content = None,
                DecodedValue::Bytes(b) => content = Some(BinaryNodeContent::Bytes(b)),
                DecodedValue::Str(s) => content = Some(BinaryNodeContent::String(s)),
            }
        }
    }

    Ok(BinaryNode { tag, attrs, content })
}

/// Decodes raw WhatsApp binary node bytes into a `BinaryNode`.
pub fn decode_binary_node(data: &[u8]) -> Result<BinaryNode, ProtoError> {
    let mut reader = ByteReader::new(data);
    decode_node_internal(&mut reader)
}

/// Decodes framed stanza: reads the 1-byte flag, then parses the result.
/// Returns error if stream end marker is received.
pub fn decode_binary_node_stanza(stanza: &[u8]) -> Result<BinaryNode, ProtoError> {
    let mut reader = ByteReader::new(stanza);
    let flag = reader.read_u8()?;
    if flag == STREAM_END && reader.is_empty() {
        return Err(ProtoError::StreamEndStanza);
    }
    let node_bytes = reader.read_bytes(reader.remaining())?;
    if (flag & 0x02) != 0 {
        // Compressed payload: handled via decompress or returns error if decompression required
        return Err(ProtoError::DecompressionFailed(
            "compressed stanza decompression requires flate2 / miniz_oxide".into(),
        ));
    }
    decode_binary_node(node_bytes)
}
