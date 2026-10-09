// [xihanzu-NR]
//! Unit tests for BinaryNode serialization and viewOnce button payload builder validation.

use serde_json::Value;
use zapapp_core::message::builder::{
    build_interactive_button_addon_node, inspect_interactive_message, is_view_once,
    unwrap_view_once, wrap_as_view_once, wrap_as_view_once_v2, InteractiveMessageBuilder,
};
use zapapp_core::message::buttons::{
    Button, NativeFlowButton, NativeFlowResponse, BUTTON_NAME_CTA_COPY, BUTTON_NAME_CTA_URL,
    BUTTON_NAME_QUICK_REPLY,
};
use zapapp_core::proto::node::{
    decode_binary_node, decode_binary_node_stanza, encode_binary_node, encode_binary_node_stanza,
    BinaryNode, NodeAttrs,
};
use zapapp_core::proto::stanza::{
    ButtonAddonKind, TAG_BIZ, TAG_ENC, TAG_INTERACTIVE, TAG_MESSAGE, TAG_NATIVE_FLOW,
};

// ---------------------------------------------------------------------------
// BinaryNode Serialization / Deserialization Tests
// ---------------------------------------------------------------------------

#[test]
fn test_binary_node_simple_tags_roundtrip() {
    let tags = ["ping", "ack", "iq", "message", "receipt", "presence"];
    for tag in tags {
        let node = BinaryNode::new_empty(tag);
        let encoded = encode_binary_node(&node);
        assert!(!encoded.is_empty());

        let decoded = decode_binary_node(&encoded).expect("failed to decode binary node");
        assert_eq!(decoded.tag, tag);
        assert!(decoded.attrs.is_empty());
        assert!(decoded.content.is_none());
    }
}

#[test]
fn test_binary_node_attributes_roundtrip() {
    let mut attrs = NodeAttrs::new();
    attrs.insert("id", "3EB0ABC123");
    attrs.insert("to", "628123456789@s.whatsapp.net");
    attrs.insert("type", "text");
    attrs.insert("xmlns", "jabber:client");

    let node = BinaryNode::new_with_attrs("message", attrs);
    let encoded = encode_binary_node(&node);
    let decoded = decode_binary_node(&encoded).expect("decode message with attrs failed");

    assert_eq!(decoded.tag, "message");
    assert_eq!(decoded.attr("id"), Some("3EB0ABC123"));
    assert_eq!(decoded.attr("to"), Some("628123456789@s.whatsapp.net"));
    assert_eq!(decoded.attr("type"), Some("text"));
    assert_eq!(decoded.attr("xmlns"), Some("jabber:client"));
}

#[test]
fn test_binary_node_content_variants_roundtrip() {
    // 1. String content
    let mut str_attrs = NodeAttrs::new();
    str_attrs.insert("v", "1");
    let str_node = BinaryNode::new_with_string(
        "body",
        str_attrs,
        "Hello from WhatsApp binary codec!",
    );
    let str_enc = encode_binary_node(&str_node);
    let str_dec = decode_binary_node(&str_enc).unwrap();
    assert_eq!(
        str_dec.content.as_ref().and_then(|c| c.as_str()),
        Some("Hello from WhatsApp binary codec!")
    );

    // 2. Binary bytes content
    let raw_payload = vec![0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02, 0x03, 0x04];
    let bytes_node = BinaryNode::new_with_bytes(
        "enc",
        NodeAttrs::new(),
        raw_payload.clone(),
    );
    let bytes_enc = encode_binary_node(&bytes_node);
    let bytes_dec = decode_binary_node(&bytes_enc).unwrap();
    assert_eq!(
        bytes_dec.content.as_ref().and_then(|c| c.as_bytes()),
        Some(raw_payload.as_slice())
    );

    // 3. Child nodes content
    let child1 = BinaryNode::new_empty("item1");
    let child2 = BinaryNode::new_empty("item2");
    let parent = BinaryNode::new_with_children("list", NodeAttrs::new(), vec![child1, child2]);
    let parent_enc = encode_binary_node(&parent);
    let parent_dec = decode_binary_node(&parent_enc).unwrap();
    let children = parent_dec.children().expect("expected children");
    assert_eq!(children.len(), 2);
    assert_eq!(children[0].tag, "item1");
    assert_eq!(children[1].tag, "item2");
}

#[test]
fn test_binary_node_stanza_framing_roundtrip() {
    let mut attrs = NodeAttrs::new();
    attrs.insert("id", "ping_001");
    attrs.insert("xmlns", "w:p");
    attrs.insert("type", "get");
    let node = BinaryNode::new_with_attrs("iq", attrs);

    // Stanza encoding prepends the 1-byte frame flag (0x00)
    let framed = encode_binary_node_stanza(&node);
    assert_eq!(framed[0], 0x00);

    let decoded = decode_binary_node_stanza(&framed).expect("decode stanza failed");
    assert_eq!(decoded.tag, "iq");
    assert_eq!(decoded.attr("id"), Some("ping_001"));
    assert_eq!(decoded.attr("type"), Some("get"));
}

// ---------------------------------------------------------------------------
// ViewOnce Button Payload Builder & Addon Node Validation
// ---------------------------------------------------------------------------

#[test]
fn test_interactive_button_addon_node_structure() {
    let biz_node = build_interactive_button_addon_node();
    assert_eq!(biz_node.tag, TAG_BIZ);

    let interactive = biz_node
        .child(TAG_INTERACTIVE)
        .expect("expected interactive child in biz node");
    assert_eq!(interactive.attr("type"), Some("native_flow"));
    assert_eq!(interactive.attr("v"), Some("1"));

    let native_flow = interactive
        .child(TAG_NATIVE_FLOW)
        .expect("expected native_flow child in interactive node");
    assert_eq!(native_flow.attr("name"), Some("mixed"));
    assert_eq!(native_flow.attr("v"), Some("9"));

    // Verify binary node codec roundtrip of the addon node
    let encoded = encode_binary_node(&biz_node);
    let decoded = decode_binary_node(&encoded).expect("failed to decode biz node");
    assert_eq!(decoded.tag, TAG_BIZ);
    let dec_inter = decoded.child(TAG_INTERACTIVE).unwrap();
    assert_eq!(dec_inter.attr("type"), Some("native_flow"));
    let dec_flow = dec_inter.child(TAG_NATIVE_FLOW).unwrap();
    assert_eq!(dec_flow.attr("name"), Some("mixed"));
    assert_eq!(dec_flow.attr("v"), Some("9"));

    // Also test generic builder with Interactive kind
    let generic_node =
        zapapp_core::proto::stanza::build_button_addon_node(ButtonAddonKind::Interactive);
    assert_eq!(generic_node.tag, TAG_BIZ);
}

#[test]
fn test_button_variants_and_json_schemas() {
    // 1. Quick Reply
    let qr = Button::quick_reply("Pilih Opsi", "opt_choice_1");
    assert_eq!(qr.name(), BUTTON_NAME_QUICK_REPLY);
    assert_eq!(qr.display_text(), "Pilih Opsi");

    let qr_json: Value = serde_json::from_str(&qr.to_params_json()).unwrap();
    assert_eq!(qr_json["display_text"], "Pilih Opsi");
    assert_eq!(qr_json["id"], "opt_choice_1");

    // 2. CTA URL (default merchant)
    let cta_url = Button::cta_url("Kunjungi Web", "https://zapapp.id");
    assert_eq!(cta_url.name(), BUTTON_NAME_CTA_URL);
    let cta_json: Value = serde_json::from_str(&cta_url.to_params_json()).unwrap();
    assert_eq!(cta_json["display_text"], "Kunjungi Web");
    assert_eq!(cta_json["url"], "https://zapapp.id");
    assert_eq!(cta_json["merchant_url"], "https://zapapp.id");

    // 3. CTA URL with distinct merchant URL
    let cta_merchant = Button::cta_url_with_merchant(
        "Daftar Event",
        "https://short.link/evt",
        "https://fullsite.org/register",
    );
    let cta_m_json: Value = serde_json::from_str(&cta_merchant.to_params_json()).unwrap();
    assert_eq!(cta_m_json["url"], "https://short.link/evt");
    assert_eq!(cta_m_json["merchant_url"], "https://fullsite.org/register");

    // 4. CTA Copy
    let cta_copy = Button::copy("Salin Kode Kupon", "DISKON2026");
    assert_eq!(cta_copy.name(), BUTTON_NAME_CTA_COPY);
    let copy_json: Value = serde_json::from_str(&cta_copy.to_params_json()).unwrap();
    assert_eq!(copy_json["display_text"], "Salin Kode Kupon");
    assert_eq!(copy_json["copy_code"], "DISKON2026");
}

#[test]
fn test_native_flow_button_wire_codec_roundtrip() {
    let buttons = vec![
        Button::quick_reply("OK", "btn_ok"),
        Button::cta_url("Link", "https://example.com"),
        Button::copy("Kode", "123456"),
    ];

    for btn in buttons {
        let nfb: NativeFlowButton = (&btn).into();
        let wire_bytes = nfb.to_wire_bytes();
        assert!(!wire_bytes.is_empty());

        let decoded = NativeFlowButton::from_wire_bytes(&wire_bytes)
            .expect("failed to decode NativeFlowButton wire format");
        assert_eq!(decoded.name, btn.name());
        assert_eq!(decoded.button_params_json, btn.to_params_json());
    }
}

#[test]
fn test_view_once_wrapping_and_unwrapping() {
    let inner_payload = vec![0x0A, 0x0C, b'm', b'e', b's', b's', b'a', b'g', b'e', b'_', b'd', b'a', b't', b'a'];

    // Initially unwrapped
    assert!(!is_view_once(&inner_payload));

    // Wrap in viewOnceMessage (field 37)
    let wrapped = wrap_as_view_once(&inner_payload);
    assert!(is_view_once(&wrapped));
    assert_ne!(wrapped, inner_payload);

    // Idempotency check: wrapping already wrapped payload does not add redundant layer
    let double_wrapped = wrap_as_view_once(&wrapped);
    assert_eq!(double_wrapped, wrapped);

    // Unwrap back to original bytes
    let recovered = unwrap_view_once(&wrapped).expect("failed to unwrap view_once");
    assert_eq!(recovered, inner_payload);

    // Wrap in viewOnceMessageV2 (field 55)
    let wrapped_v2 = wrap_as_view_once_v2(&inner_payload);
    assert!(is_view_once(&wrapped_v2));
    let recovered_v2 = unwrap_view_once(&wrapped_v2).expect("failed to unwrap view_once_v2");
    assert_eq!(recovered_v2, inner_payload);
}

#[test]
fn test_interactive_message_builder_full_validation() {
    let builder = InteractiveMessageBuilder::new()
        .title("Konfirmasi Layanan")
        .subtitle("Transaksi #9982")
        .body("Silakan pilih opsi di bawah ini untuk melanjutkan pesanan Anda.")
        .footer("ZapApp Core Engine v0.1.0")
        .add_quick_reply("Setuju", "btn_approve")
        .add_quick_reply("Tolak", "btn_reject")
        .add_cta_url("Lihat Rincian", "https://app.zapapp.id/order/9982")
        .add_copy_button("Salin ID Transaksi", "TRX-9982-XYZ")
        .view_once(true)
        .message_version(1);

    // 1. Verify Protobuf wire bytes are automatically wrapped in viewOnceMessage
    let proto_bytes = builder.build_message_proto_bytes();
    assert!(is_view_once(&proto_bytes));

    // 2. Inspect and parse interactive message contents
    let parsed = inspect_interactive_message(&proto_bytes).expect("inspect failed");
    assert!(parsed.is_view_once);
    assert_eq!(parsed.title.as_deref(), Some("Konfirmasi Layanan"));
    assert_eq!(parsed.subtitle.as_deref(), Some("Transaksi #9982"));
    assert_eq!(
        parsed.body,
        "Silakan pilih opsi di bawah ini untuk melanjutkan pesanan Anda."
    );
    assert_eq!(parsed.footer.as_deref(), Some("ZapApp Core Engine v0.1.0"));
    assert_eq!(parsed.buttons.len(), 4);

    assert_eq!(parsed.buttons[0].name, "quick_reply");
    assert!(parsed.buttons[0].button_params_json.contains("btn_approve"));
    assert_eq!(parsed.buttons[1].name, "quick_reply");
    assert!(parsed.buttons[1].button_params_json.contains("btn_reject"));
    assert_eq!(parsed.buttons[2].name, "cta_url");
    assert!(parsed.buttons[2].button_params_json.contains("https://app.zapapp.id/order/9982"));
    assert_eq!(parsed.buttons[3].name, "cta_copy");
    assert!(parsed.buttons[3].button_params_json.contains("TRX-9982-XYZ"));

    // 3. Stanza building validation
    let msg_id = "3EB099887766";
    let recipient = "628991234567@s.whatsapp.net";
    let dummy_ciphertext = vec![0x11, 0x22, 0x33, 0x44, 0x55];

    let stanza = builder.build_message_stanza(msg_id, recipient, "text", dummy_ciphertext.clone());

    assert_eq!(stanza.tag, TAG_MESSAGE);
    assert_eq!(stanza.attr("id"), Some(msg_id));
    assert_eq!(stanza.attr("to"), Some(recipient));
    assert_eq!(stanza.attr("type"), Some("text"));

    // Check children: <enc>, <biz>, <meta view_once="true"/>
    let enc_child = stanza.child(TAG_ENC).expect("missing enc node");
    assert_eq!(enc_child.attr("type"), Some("text"));
    assert_eq!(
        enc_child.content.as_ref().and_then(|c| c.as_bytes()),
        Some(dummy_ciphertext.as_slice())
    );

    let biz_child = stanza.child(TAG_BIZ).expect("missing biz node");
    assert!(biz_child.child(TAG_INTERACTIVE).is_some());

    let meta_child = stanza.child("meta").expect("missing meta node");
    assert_eq!(meta_child.attr("view_once"), Some("true"));

    // 4. BinaryNode encode/decode roundtrip of the entire outbound stanza
    let stanza_bytes = encode_binary_node(&stanza);
    assert!(!stanza_bytes.is_empty());

    let decoded_stanza = decode_binary_node(&stanza_bytes).expect("failed to decode stanza");
    assert_eq!(decoded_stanza.tag, TAG_MESSAGE);
    assert_eq!(decoded_stanza.attr("id"), Some(msg_id));
    assert_eq!(decoded_stanza.attr("to"), Some(recipient));
    assert!(decoded_stanza.child(TAG_ENC).is_some());
    assert!(decoded_stanza.child(TAG_BIZ).is_some());
    assert!(decoded_stanza.child("meta").is_some());
}

#[test]
fn test_interactive_message_builder_without_view_once() {
    let builder = InteractiveMessageBuilder::new()
        .body("Plain interactive without view once")
        .add_quick_reply("OK", "btn_ok")
        .view_once(false);

    let proto_bytes = builder.build_message_proto_bytes();
    assert!(!is_view_once(&proto_bytes));

    let parsed = inspect_interactive_message(&proto_bytes).unwrap();
    assert!(!parsed.is_view_once);
    assert_eq!(parsed.body, "Plain interactive without view once");

    let stanza = builder.build_message_stanza("id1", "to1", "msg", vec![1, 2]);
    assert!(stanza.child("meta").is_none());
}

#[test]
fn test_native_flow_response_parsing() {
    // 1. Quick reply click response with "id"
    let raw_json_1 = r#"{"id":"btn_approve","display_text":"Setuju"}"#;
    let resp1 = NativeFlowResponse::parse(raw_json_1).unwrap();
    assert_eq!(resp1.selected_id.as_deref(), Some("btn_approve"));
    assert_eq!(resp1.display_text.as_deref(), Some("Setuju"));
    assert_eq!(resp1.raw_json, raw_json_1);

    // 2. Alternate key "selected_id"
    let raw_json_2 = r#"{"selected_id":"btn_opt_2"}"#;
    let resp2 = NativeFlowResponse::parse(raw_json_2).unwrap();
    assert_eq!(resp2.selected_id.as_deref(), Some("btn_opt_2"));
    assert_eq!(resp2.display_text, None);
}
