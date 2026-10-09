// [xihanzu-NR]
//! Interactive Message Builder and ViewOnce Wrapper.
//! Mirrors zapo's `buildButtonAddonNode` and `wrapAsViewOnce`:
//! - Builds `<biz><interactive type="native_flow" v="1"><native_flow v="9" name="mixed"/></interactive></biz>` node
//! - Formats native flow interactive messages with Quick Reply, CTA URL, and Copy buttons
//! - Automatically wraps interactive messages into `viewOnceMessage` to bypass Meta's client-side button block

use crate::message::buttons::{Button, NativeFlowButton};
use crate::proto::node::{BinaryNode, NodeAttrs, ProtoError};
use crate::proto::stanza::{
    build_button_addon_node as proto_build_button_addon_node, build_enc_node, ButtonAddonKind,
    ProtoWireReader, ProtoWireWriter, TAG_BIZ, TAG_INTERACTIVE, TAG_MESSAGE, TAG_NATIVE_FLOW,
};

// ---------------------------------------------------------------------------
// Protobuf Field Constants (WAProto Specification)
// ---------------------------------------------------------------------------

// Message envelope fields
pub const FIELD_VIEW_ONCE_MESSAGE: u32 = 37;
pub const FIELD_INTERACTIVE_MESSAGE: u32 = 45;
pub const FIELD_VIEW_ONCE_MESSAGE_V2: u32 = 55;

// FutureProofMessage fields
pub const FIELD_FUTURE_PROOF_MESSAGE: u32 = 1;

// InteractiveMessage fields
pub const FIELD_INTERACTIVE_HEADER: u32 = 1;
pub const FIELD_INTERACTIVE_BODY: u32 = 2;
pub const FIELD_INTERACTIVE_FOOTER: u32 = 3;
pub const FIELD_INTERACTIVE_NATIVE_FLOW: u32 = 6;
pub const FIELD_INTERACTIVE_CONTEXT_INFO: u32 = 15;

// Header fields
pub const FIELD_HEADER_TITLE: u32 = 1;
pub const FIELD_HEADER_SUBTITLE: u32 = 2;
pub const FIELD_HEADER_HAS_MEDIA_ATTACHMENT: u32 = 5;

// Body fields
pub const FIELD_BODY_TEXT: u32 = 1;

// Footer fields
pub const FIELD_FOOTER_TEXT: u32 = 1;

// NativeFlowMessage fields
pub const FIELD_NATIVE_FLOW_BUTTONS: u32 = 1;
pub const FIELD_NATIVE_FLOW_MESSAGE_PARAMS_JSON: u32 = 2;
pub const FIELD_NATIVE_FLOW_MESSAGE_VERSION: u32 = 3;

// ---------------------------------------------------------------------------
// Button Addon Stanza Builder (mirroring zapo's buildButtonAddonNode)
// ---------------------------------------------------------------------------

/// Builds a `<biz><interactive type="native_flow" v="1"><native_flow v="9" name="mixed"/></interactive></biz>` node.
/// Mirrors zapo's `buildButtonAddonNode('interactive')`.
pub fn build_interactive_button_addon_node() -> BinaryNode {
    let mut flow_attrs = NodeAttrs::new();
    flow_attrs.insert("name", "mixed");
    flow_attrs.insert("v", "9");
    let flow_node = BinaryNode::new_with_attrs(TAG_NATIVE_FLOW, flow_attrs);

    let mut inter_attrs = NodeAttrs::new();
    inter_attrs.insert("type", TAG_NATIVE_FLOW);
    inter_attrs.insert("v", "1");
    let inter_node = BinaryNode::new_with_children(TAG_INTERACTIVE, inter_attrs, vec![flow_node]);

    BinaryNode::new_with_children(TAG_BIZ, NodeAttrs::new(), vec![inter_node])
}

/// Generic button addon node builder mirroring zapo's `buildButtonAddonNode`.
pub fn build_button_addon_node(kind: ButtonAddonKind) -> BinaryNode {
    proto_build_button_addon_node(kind)
}

// ---------------------------------------------------------------------------
// ViewOnce Wrapping & Unwrapping (mirroring zapo's wrapAsViewOnce)
// ---------------------------------------------------------------------------

/// Checks if raw `Message` protobuf wire bytes already contain `viewOnceMessage` (field 37)
/// or `viewOnceMessageV2` (field 55).
pub fn is_view_once(message_bytes: &[u8]) -> bool {
    let mut reader = ProtoWireReader::new(message_bytes);
    while !reader.is_empty() {
        match reader.read_tag() {
            Ok((field_number, wire_type)) => {
                if field_number == FIELD_VIEW_ONCE_MESSAGE
                    || field_number == FIELD_VIEW_ONCE_MESSAGE_V2
                {
                    return true;
                }
                if reader.skip_field(wire_type).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    false
}

/// Wraps message bytes in a `viewOnceMessage` (field 37) FutureProofMessage envelope.
/// If already wrapped in `viewOnceMessage` or `viewOnceMessageV2`, returns bytes unchanged (idempotent).
/// Mirrors zapo's `wrapAsViewOnce`.
pub fn wrap_as_view_once(message_bytes: &[u8]) -> Vec<u8> {
    if is_view_once(message_bytes) {
        return message_bytes.to_vec();
    }

    // FutureProofMessage { message: message_bytes } -> field 1
    let mut fp_writer = ProtoWireWriter::new();
    fp_writer.write_bytes_field(FIELD_FUTURE_PROOF_MESSAGE, message_bytes);
    let fp_bytes = fp_writer.into_bytes();

    // Message { viewOnceMessage: FutureProofMessage } -> field 37
    let mut outer_writer = ProtoWireWriter::new();
    outer_writer.write_bytes_field(FIELD_VIEW_ONCE_MESSAGE, &fp_bytes);
    outer_writer.into_bytes()
}

/// Wraps message bytes in a `viewOnceMessageV2` (field 55) FutureProofMessage envelope.
pub fn wrap_as_view_once_v2(message_bytes: &[u8]) -> Vec<u8> {
    if is_view_once(message_bytes) {
        return message_bytes.to_vec();
    }

    let mut fp_writer = ProtoWireWriter::new();
    fp_writer.write_bytes_field(FIELD_FUTURE_PROOF_MESSAGE, message_bytes);
    let fp_bytes = fp_writer.into_bytes();

    let mut outer_writer = ProtoWireWriter::new();
    outer_writer.write_bytes_field(FIELD_VIEW_ONCE_MESSAGE_V2, &fp_bytes);
    outer_writer.into_bytes()
}

/// Unwraps a `viewOnceMessage` or `viewOnceMessageV2` envelope down to the inner `Message` bytes.
/// If not wrapped, returns the original bytes.
pub fn unwrap_view_once(message_bytes: &[u8]) -> Result<Vec<u8>, ProtoError> {
    let mut reader = ProtoWireReader::new(message_bytes);
    while !reader.is_empty() {
        let (field_number, wire_type) = reader.read_tag()?;
        if field_number == FIELD_VIEW_ONCE_MESSAGE || field_number == FIELD_VIEW_ONCE_MESSAGE_V2 {
            let fp_bytes = reader.read_length_delimited()?;
            let mut fp_reader = ProtoWireReader::new(fp_bytes);
            while !fp_reader.is_empty() {
                let (fp_fn, fp_wt) = fp_reader.read_tag()?;
                if fp_fn == FIELD_FUTURE_PROOF_MESSAGE {
                    let inner = fp_reader.read_length_delimited()?;
                    return Ok(inner.to_vec());
                }
                fp_reader.skip_field(fp_wt)?;
            }
            return Err(ProtoError::Custom(
                "FutureProofMessage missing message field".into(),
            ));
        }
        reader.skip_field(wire_type)?;
    }
    Ok(message_bytes.to_vec())
}

// ---------------------------------------------------------------------------
// Interactive Message Builder
// ---------------------------------------------------------------------------

/// High-level builder for WhatsApp interactive messages with native flow buttons.
/// Automatically wraps in `viewOnceMessage` by default to bypass Meta's client-side button block.
#[derive(Debug, Clone, Default)]
pub struct InteractiveMessageBuilder {
    pub body: String,
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub footer: Option<String>,
    pub buttons: Vec<Button>,
    pub view_once: bool,
    pub message_params_json: Option<String>,
    pub message_version: u32,
}

impl InteractiveMessageBuilder {
    /// Creates a new `InteractiveMessageBuilder`.
    /// `view_once` is initialized to `true` to ensure client rendering.
    pub fn new() -> Self {
        Self {
            body: String::new(),
            title: None,
            subtitle: None,
            footer: None,
            buttons: Vec::new(),
            view_once: true,
            message_params_json: None,
            message_version: 1,
        }
    }

    /// Sets the body text (main message text).
    pub fn body(mut self, text: impl Into<String>) -> Self {
        self.body = text.into();
        self
    }

    /// Sets the header title.
    pub fn title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// Sets the header subtitle.
    pub fn subtitle(mut self, subtitle: impl Into<String>) -> Self {
        self.subtitle = Some(subtitle.into());
        self
    }

    /// Sets the footer text.
    pub fn footer(mut self, footer: impl Into<String>) -> Self {
        self.footer = Some(footer.into());
        self
    }

    /// Adds a button.
    pub fn add_button(mut self, button: Button) -> Self {
        self.buttons.push(button);
        self
    }

    /// Adds a Quick Reply button.
    pub fn add_quick_reply(mut self, display_text: impl Into<String>, id: impl Into<String>) -> Self {
        self.buttons.push(Button::quick_reply(display_text, id));
        self
    }

    /// Adds a Call-To-Action URL button.
    pub fn add_cta_url(mut self, display_text: impl Into<String>, url: impl Into<String>) -> Self {
        self.buttons.push(Button::cta_url(display_text, url));
        self
    }

    /// Adds a Call-To-Action URL button with custom merchant URL.
    pub fn add_cta_url_with_merchant(
        mut self,
        display_text: impl Into<String>,
        url: impl Into<String>,
        merchant_url: impl Into<String>,
    ) -> Self {
        self.buttons
            .push(Button::cta_url_with_merchant(display_text, url, merchant_url));
        self
    }

    /// Adds a Call-To-Action Copy button (for OTP codes, voucher codes, etc).
    pub fn add_copy_button(
        mut self,
        display_text: impl Into<String>,
        copy_code: impl Into<String>,
    ) -> Self {
        self.buttons.push(Button::copy(display_text, copy_code));
        self
    }

    /// Sets whether to wrap in `viewOnceMessage` (defaults to true).
    pub fn view_once(mut self, enable: bool) -> Self {
        self.view_once = enable;
        self
    }

    /// Sets optional messageParamsJson string.
    pub fn message_params_json(mut self, json_str: impl Into<String>) -> Self {
        self.message_params_json = Some(json_str.into());
        self
    }

    /// Sets the messageVersion integer.
    pub fn message_version(mut self, version: u32) -> Self {
        self.message_version = version;
        self
    }

    /// Encodes only the inner `InteractiveMessage` protobuf bytes.
    pub fn build_interactive_proto_bytes(&self) -> Vec<u8> {
        let mut inter_writer = ProtoWireWriter::new();

        // 1. Header (if title or subtitle present)
        if self.title.is_some() || self.subtitle.is_some() {
            let mut header_writer = ProtoWireWriter::new();
            if let Some(ref t) = self.title {
                header_writer.write_string_field(FIELD_HEADER_TITLE, t);
            }
            if let Some(ref st) = self.subtitle {
                header_writer.write_string_field(FIELD_HEADER_SUBTITLE, st);
            }
            inter_writer.write_bytes_field(FIELD_INTERACTIVE_HEADER, &header_writer.into_bytes());
        }

        // 2. Body
        if !self.body.is_empty() {
            let mut body_writer = ProtoWireWriter::new();
            body_writer.write_string_field(FIELD_BODY_TEXT, &self.body);
            inter_writer.write_bytes_field(FIELD_INTERACTIVE_BODY, &body_writer.into_bytes());
        }

        // 3. Footer
        if let Some(ref f) = self.footer {
            let mut footer_writer = ProtoWireWriter::new();
            footer_writer.write_string_field(FIELD_FOOTER_TEXT, f);
            inter_writer.write_bytes_field(FIELD_INTERACTIVE_FOOTER, &footer_writer.into_bytes());
        }

        // 6. NativeFlowMessage
        let mut flow_writer = ProtoWireWriter::new();
        for btn in &self.buttons {
            let nfb = btn.to_native_flow_button();
            let btn_wire = nfb.to_wire_bytes();
            flow_writer.write_bytes_field(FIELD_NATIVE_FLOW_BUTTONS, &btn_wire);
        }
        if let Some(ref params) = self.message_params_json {
            flow_writer.write_string_field(FIELD_NATIVE_FLOW_MESSAGE_PARAMS_JSON, params);
        }
        if self.message_version > 0 {
            flow_writer.write_uint32_field(FIELD_NATIVE_FLOW_MESSAGE_VERSION, self.message_version);
        }

        inter_writer.write_bytes_field(FIELD_INTERACTIVE_NATIVE_FLOW, &flow_writer.into_bytes());
        inter_writer.into_bytes()
    }

    /// Encodes the complete `Message` protobuf wire bytes.
    /// If `view_once` is true (default), automatically wraps in `viewOnceMessage` (field 37).
    pub fn build_message_proto_bytes(&self) -> Vec<u8> {
        let inter_bytes = self.build_interactive_proto_bytes();

        let mut msg_writer = ProtoWireWriter::new();
        msg_writer.write_bytes_field(FIELD_INTERACTIVE_MESSAGE, &inter_bytes);
        let inner_msg_bytes = msg_writer.into_bytes();

        if self.view_once {
            wrap_as_view_once(&inner_msg_bytes)
        } else {
            inner_msg_bytes
        }
    }

    /// Builds the `<biz>` button addon node required for WhatsApp to render native flow buttons.
    pub fn build_button_addon_node(&self) -> BinaryNode {
        build_interactive_button_addon_node()
    }

    /// Builds the optional `<meta view_once="true"/>` node when view_once is active.
    pub fn build_meta_node(&self) -> Option<BinaryNode> {
        if self.view_once {
            let mut attrs = NodeAttrs::new();
            attrs.insert("view_once", "true");
            Some(BinaryNode::new_with_attrs("meta", attrs))
        } else {
            None
        }
    }

    /// Builds the full outbound `<message>` XML stanza ready for transmission.
    /// Includes encrypted `<enc>` node, `<biz>` button addon node, and `<meta view_once="true"/>` node.
    pub fn build_message_stanza(
        &self,
        id: &str,
        to: &str,
        enc_type: &str,
        ciphertext: Vec<u8>,
    ) -> BinaryNode {
        let enc_node = build_enc_node(enc_type, ciphertext, None, None, None);
        let biz_node = self.build_button_addon_node();

        let mut children = vec![enc_node, biz_node];
        if let Some(meta) = self.build_meta_node() {
            children.push(meta);
        }

        let mut attrs = NodeAttrs::new();
        attrs.insert("id", id);
        attrs.insert("to", to);
        attrs.insert("type", "text");
        BinaryNode::new_with_children(TAG_MESSAGE, attrs, children)
    }
}

// ---------------------------------------------------------------------------
// Inspection & Parsing Helpers
// ---------------------------------------------------------------------------

/// Parsed interactive message summary for incoming or debug stanzas.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedInteractiveMessage {
    pub body: String,
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub footer: Option<String>,
    pub buttons: Vec<NativeFlowButton>,
    pub is_view_once: bool,
}

/// Parses and inspects an interactive message from raw protobuf bytes.
pub fn inspect_interactive_message(raw_bytes: &[u8]) -> Result<ParsedInteractiveMessage, ProtoError> {
    let was_view_once = is_view_once(raw_bytes);
    let unwrapped = unwrap_view_once(raw_bytes)?;

    let mut msg_reader = ProtoWireReader::new(&unwrapped);
    let mut interactive_bytes = None;

    while !msg_reader.is_empty() {
        let (field_num, wire_type) = msg_reader.read_tag()?;
        if field_num == FIELD_INTERACTIVE_MESSAGE {
            interactive_bytes = Some(msg_reader.read_length_delimited()?);
            break;
        }
        msg_reader.skip_field(wire_type)?;
    }

    let inter_data = match interactive_bytes {
        Some(b) => b,
        None => return Err(ProtoError::Custom("no interactiveMessage field found".into())),
    };

    let mut inter_reader = ProtoWireReader::new(inter_data);
    let mut title = None;
    let mut subtitle = None;
    let mut body = String::new();
    let mut footer = None;
    let mut buttons = Vec::new();

    while !inter_reader.is_empty() {
        let (fn_num, wt) = inter_reader.read_tag()?;
        match fn_num {
            FIELD_INTERACTIVE_HEADER => {
                let hdr_bytes = inter_reader.read_length_delimited()?;
                let mut hdr_reader = ProtoWireReader::new(hdr_bytes);
                while !hdr_reader.is_empty() {
                    let (hfn, hwt) = hdr_reader.read_tag()?;
                    match hfn {
                        FIELD_HEADER_TITLE => title = Some(hdr_reader.read_string()?.to_string()),
                        FIELD_HEADER_SUBTITLE => {
                            subtitle = Some(hdr_reader.read_string()?.to_string())
                        }
                        _ => hdr_reader.skip_field(hwt)?,
                    }
                }
            }
            FIELD_INTERACTIVE_BODY => {
                let body_bytes = inter_reader.read_length_delimited()?;
                let mut b_reader = ProtoWireReader::new(body_bytes);
                while !b_reader.is_empty() {
                    let (bfn, bwt) = b_reader.read_tag()?;
                    if bfn == FIELD_BODY_TEXT {
                        body = b_reader.read_string()?.to_string();
                    } else {
                        b_reader.skip_field(bwt)?;
                    }
                }
            }
            FIELD_INTERACTIVE_FOOTER => {
                let f_bytes = inter_reader.read_length_delimited()?;
                let mut f_reader = ProtoWireReader::new(f_bytes);
                while !f_reader.is_empty() {
                    let (ffn, fwt) = f_reader.read_tag()?;
                    if ffn == FIELD_FOOTER_TEXT {
                        footer = Some(f_reader.read_string()?.to_string());
                    } else {
                        f_reader.skip_field(fwt)?;
                    }
                }
            }
            FIELD_INTERACTIVE_NATIVE_FLOW => {
                let flow_bytes = inter_reader.read_length_delimited()?;
                let mut flow_reader = ProtoWireReader::new(flow_bytes);
                while !flow_reader.is_empty() {
                    let (ffn, fwt) = flow_reader.read_tag()?;
                    if ffn == FIELD_NATIVE_FLOW_BUTTONS {
                        let btn_bytes = flow_reader.read_length_delimited()?;
                        let btn = NativeFlowButton::from_wire_bytes(btn_bytes)?;
                        buttons.push(btn);
                    } else {
                        flow_reader.skip_field(fwt)?;
                    }
                }
            }
            _ => inter_reader.skip_field(wt)?,
        }
    }

    Ok(ParsedInteractiveMessage {
        body,
        title,
        subtitle,
        footer,
        buttons,
        is_view_once: was_view_once,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::stanza::{TAG_ENC, TAG_INTERACTIVE, TAG_NATIVE_FLOW};

    #[test]
    fn test_build_interactive_button_addon_node() {
        let biz_node = build_interactive_button_addon_node();
        assert_eq!(biz_node.tag, TAG_BIZ);

        let inter = biz_node
            .child(TAG_INTERACTIVE)
            .expect("expected interactive child");
        assert_eq!(inter.attr("type"), Some("native_flow"));
        assert_eq!(inter.attr("v"), Some("1"));

        let flow = inter
            .child(TAG_NATIVE_FLOW)
            .expect("expected native_flow child");
        assert_eq!(flow.attr("name"), Some("mixed"));
        assert_eq!(flow.attr("v"), Some("9"));
    }

    #[test]
    fn test_view_once_wrapper_and_idempotency() {
        let raw = vec![0x12, 0x05, b'h', b'e', b'l', b'l', b'o'];
        assert!(!is_view_once(&raw));

        let wrapped = wrap_as_view_once(&raw);
        assert!(is_view_once(&wrapped));

        // Idempotency: wrapping already-wrapped message does not double wrap
        let wrapped_again = wrap_as_view_once(&wrapped);
        assert_eq!(wrapped, wrapped_again);

        // Unwrapping recovers original payload
        let unwrapped = unwrap_view_once(&wrapped).unwrap();
        assert_eq!(unwrapped, raw);
    }

    #[test]
    fn test_view_once_v2_wrapper() {
        let raw = vec![0x08, 0x01];
        let wrapped_v2 = wrap_as_view_once_v2(&raw);
        assert!(is_view_once(&wrapped_v2));

        let unwrapped = unwrap_view_once(&wrapped_v2).unwrap();
        assert_eq!(unwrapped, raw);
    }

    #[test]
    fn test_interactive_message_builder_all_three_buttons() {
        let builder = InteractiveMessageBuilder::new()
            .title("Verification Required")
            .body("Please select one of the actions below to proceed.")
            .footer("Secured by ZapApp")
            .add_quick_reply("Confirm Action", "btn_confirm")
            .add_cta_url("Open Portal", "https://portal.example.com")
            .add_copy_button("Copy Token", "AUTH-99214")
            .view_once(true);

        // 1. Verify button addon node
        let addon = builder.build_button_addon_node();
        assert_eq!(addon.tag, TAG_BIZ);

        // 2. Verify protobuf serialization & viewOnce wrapping
        let proto_bytes = builder.build_message_proto_bytes();
        assert!(is_view_once(&proto_bytes));

        // 3. Inspect parsed payload
        let parsed = inspect_interactive_message(&proto_bytes).unwrap();
        assert_eq!(parsed.title.as_deref(), Some("Verification Required"));
        assert_eq!(
            parsed.body,
            "Please select one of the actions below to proceed."
        );
        assert_eq!(parsed.footer.as_deref(), Some("Secured by ZapApp"));
        assert_eq!(parsed.buttons.len(), 3);
        assert!(parsed.is_view_once);

        // Buttons check
        assert_eq!(parsed.buttons[0].name, "quick_reply");
        assert!(parsed.buttons[0]
            .button_params_json
            .contains("btn_confirm"));

        assert_eq!(parsed.buttons[1].name, "cta_url");
        assert!(parsed.buttons[1]
            .button_params_json
            .contains("https://portal.example.com"));

        assert_eq!(parsed.buttons[2].name, "cta_copy");
        assert!(parsed.buttons[2]
            .button_params_json
            .contains("AUTH-99214"));

        // 4. Stanza construction
        let stanza = builder.build_message_stanza(
            "msg_12345",
            "628123456789@s.whatsapp.net",
            "msg",
            vec![1, 2, 3, 4],
        );
        assert_eq!(stanza.tag, TAG_MESSAGE);
        assert_eq!(stanza.attr("id"), Some("msg_12345"));
        assert_eq!(stanza.attr("to"), Some("628123456789@s.whatsapp.net"));
        assert!(stanza.child(TAG_ENC).is_some());
        assert!(stanza.child(TAG_BIZ).is_some());
        assert!(stanza.child("meta").is_some());
        assert_eq!(stanza.child("meta").unwrap().attr("view_once"), Some("true"));
    }

    #[test]
    fn test_interactive_message_without_view_once() {
        let builder = InteractiveMessageBuilder::new()
            .body("Simple menu")
            .add_quick_reply("Option 1", "opt_1")
            .view_once(false);

        let proto_bytes = builder.build_message_proto_bytes();
        assert!(!is_view_once(&proto_bytes));

        let parsed = inspect_interactive_message(&proto_bytes).unwrap();
        assert_eq!(parsed.body, "Simple menu");
        assert!(!parsed.is_view_once);
    }
}
