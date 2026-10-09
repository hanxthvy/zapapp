// [xihanzu-NR]
//! Interactive Native Flow Buttons for WhatsApp messages.
//! Supports Quick Reply, CTA URL, and Copy buttons serialized to
//! WhatsApp's native_flow button JSON schema and Protobuf wire format.

use crate::proto::node::ProtoError;
use crate::proto::stanza::{ProtoWireReader, ProtoWireWriter};
use serde::{Deserialize, Serialize};
use serde_json::json;

/// Native flow button type identifiers recognized by WhatsApp clients.
pub const BUTTON_NAME_QUICK_REPLY: &str = "quick_reply";
pub const BUTTON_NAME_CTA_URL: &str = "cta_url";
pub const BUTTON_NAME_CTA_COPY: &str = "cta_copy";

/// Protobuf field numbers for `NativeFlowButton`.
pub const FIELD_BUTTON_NAME: u32 = 1;
pub const FIELD_BUTTON_PARAMS_JSON: u32 = 2;

/// Supported high-level button types for interactive messages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Button {
    /// Quick reply button that sends back an ID or text payload when tapped.
    QuickReply {
        display_text: String,
        id: String,
    },
    /// Call-To-Action URL button that opens a web link in browser/webview.
    CtaUrl {
        display_text: String,
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        merchant_url: Option<String>,
    },
    /// Call-To-Action Copy button that copies a code or text to the device clipboard.
    CtaCopy {
        display_text: String,
        copy_code: String,
    },
}

impl Button {
    /// Creates a new Quick Reply button.
    pub fn quick_reply(display_text: impl Into<String>, id: impl Into<String>) -> Self {
        Self::QuickReply {
            display_text: display_text.into(),
            id: id.into(),
        }
    }

    /// Creates a new CTA URL button.
    pub fn cta_url(display_text: impl Into<String>, url: impl Into<String>) -> Self {
        Self::CtaUrl {
            display_text: display_text.into(),
            url: url.into(),
            merchant_url: None,
        }
    }

    /// Creates a new CTA URL button with an explicit merchant URL.
    pub fn cta_url_with_merchant(
        display_text: impl Into<String>,
        url: impl Into<String>,
        merchant_url: impl Into<String>,
    ) -> Self {
        Self::CtaUrl {
            display_text: display_text.into(),
            url: url.into(),
            merchant_url: Some(merchant_url.into()),
        }
    }

    /// Creates a new CTA Copy button to copy text/code to clipboard.
    pub fn copy(display_text: impl Into<String>, copy_code: impl Into<String>) -> Self {
        Self::CtaCopy {
            display_text: display_text.into(),
            copy_code: copy_code.into(),
        }
    }

    /// Alias for `copy`.
    pub fn copy_code(display_text: impl Into<String>, copy_code: impl Into<String>) -> Self {
        Self::copy(display_text, copy_code)
    }

    /// Returns the native flow button name identifier.
    pub fn name(&self) -> &'static str {
        match self {
            Self::QuickReply { .. } => BUTTON_NAME_QUICK_REPLY,
            Self::CtaUrl { .. } => BUTTON_NAME_CTA_URL,
            Self::CtaCopy { .. } => BUTTON_NAME_CTA_COPY,
        }
    }

    /// Returns the display text shown on the button face.
    pub fn display_text(&self) -> &str {
        match self {
            Self::QuickReply { display_text, .. } => display_text,
            Self::CtaUrl { display_text, .. } => display_text,
            Self::CtaCopy { display_text, .. } => display_text,
        }
    }

    /// Serializes button parameters to WhatsApp JSON schema string.
    pub fn to_params_json(&self) -> String {
        match self {
            Self::QuickReply { display_text, id } => json!({
                "display_text": display_text,
                "id": id,
            })
            .to_string(),
            Self::CtaUrl {
                display_text,
                url,
                merchant_url,
            } => {
                let m_url = merchant_url.as_deref().unwrap_or(url);
                json!({
                    "display_text": display_text,
                    "url": url,
                    "merchant_url": m_url,
                })
                .to_string()
            }
            Self::CtaCopy {
                display_text,
                copy_code,
            } => json!({
                "display_text": display_text,
                "copy_code": copy_code,
            })
            .to_string(),
        }
    }

    /// Converts this button into a `NativeFlowButton`.
    pub fn to_native_flow_button(&self) -> NativeFlowButton {
        NativeFlowButton {
            name: self.name().to_string(),
            button_params_json: self.to_params_json(),
        }
    }
}

/// Low-level Protobuf `NativeFlowButton` representing `{ name, buttonParamsJson }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeFlowButton {
    /// Action name (e.g. "quick_reply", "cta_url", "cta_copy").
    pub name: String,
    /// Serialized JSON string of parameters.
    pub button_params_json: String,
}

impl NativeFlowButton {
    /// Creates a new `NativeFlowButton`.
    pub fn new(name: impl Into<String>, button_params_json: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            button_params_json: button_params_json.into(),
        }
    }

    /// Encodes this `NativeFlowButton` into protobuf wire format.
    pub fn encode_to_wire(&self, writer: &mut ProtoWireWriter) {
        if !self.name.is_empty() {
            writer.write_string_field(FIELD_BUTTON_NAME, &self.name);
        }
        if !self.button_params_json.is_empty() {
            writer.write_string_field(FIELD_BUTTON_PARAMS_JSON, &self.button_params_json);
        }
    }

    /// Returns protobuf wire-encoded bytes.
    pub fn to_wire_bytes(&self) -> Vec<u8> {
        let mut writer = ProtoWireWriter::new();
        self.encode_to_wire(&mut writer);
        writer.into_bytes()
    }

    /// Decodes a `NativeFlowButton` from protobuf wire bytes.
    pub fn decode_from_wire(reader: &mut ProtoWireReader) -> Result<Self, ProtoError> {
        let mut name = String::new();
        let mut button_params_json = String::new();

        while !reader.is_empty() {
            let (field_number, wire_type) = reader.read_tag()?;
            match field_number {
                FIELD_BUTTON_NAME => {
                    name = reader.read_string()?.to_string();
                }
                FIELD_BUTTON_PARAMS_JSON => {
                    button_params_json = reader.read_string()?.to_string();
                }
                _ => {
                    reader.skip_field(wire_type)?;
                }
            }
        }

        Ok(Self {
            name,
            button_params_json,
        })
    }

    /// Convenience decoder from raw bytes.
    pub fn from_wire_bytes(bytes: &[u8]) -> Result<Self, ProtoError> {
        let mut reader = ProtoWireReader::new(bytes);
        Self::decode_from_wire(&mut reader)
    }
}

impl From<&Button> for NativeFlowButton {
    fn from(b: &Button) -> Self {
        b.to_native_flow_button()
    }
}

impl From<Button> for NativeFlowButton {
    fn from(b: Button) -> Self {
        b.to_native_flow_button()
    }
}

/// Parsed response when a user clicks a native flow button.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeFlowResponse {
    /// Selected button ID (for quick reply).
    pub selected_id: Option<String>,
    /// Selected display text if provided.
    pub display_text: Option<String>,
    /// Raw params JSON string received in response stanza.
    pub raw_json: String,
}

impl NativeFlowResponse {
    /// Parses native flow response from JSON params string.
    pub fn parse(params_json: &str) -> Result<Self, serde_json::Error> {
        let val: serde_json::Value = serde_json::from_str(params_json)?;
        let selected_id = val
            .get("id")
            .or_else(|| val.get("selected_id"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let display_text = val
            .get("display_text")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        Ok(Self {
            selected_id,
            display_text,
            raw_json: params_json.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_quick_reply_button() {
        let btn = Button::quick_reply("Yes, Confirm", "action_confirm");
        assert_eq!(btn.name(), BUTTON_NAME_QUICK_REPLY);
        assert_eq!(btn.display_text(), "Yes, Confirm");

        let json_str = btn.to_params_json();
        let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();
        assert_eq!(parsed["display_text"], "Yes, Confirm");
        assert_eq!(parsed["id"], "action_confirm");

        let nfb = btn.to_native_flow_button();
        assert_eq!(nfb.name, "quick_reply");
        let wire = nfb.to_wire_bytes();
        let decoded = NativeFlowButton::from_wire_bytes(&wire).unwrap();
        assert_eq!(decoded.name, "quick_reply");
        assert_eq!(decoded.button_params_json, json_str);
    }

    #[test]
    fn test_cta_url_button() {
        let btn = Button::cta_url("Open Dashboard", "https://app.hxdev.id");
        assert_eq!(btn.name(), BUTTON_NAME_CTA_URL);

        let json_str = btn.to_params_json();
        let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();
        assert_eq!(parsed["display_text"], "Open Dashboard");
        assert_eq!(parsed["url"], "https://app.hxdev.id");
        assert_eq!(parsed["merchant_url"], "https://app.hxdev.id");

        let btn_m = Button::cta_url_with_merchant("Open", "https://t.co/abc", "https://hxdev.id");
        let json_m = btn_m.to_params_json();
        let parsed_m: serde_json::Value = serde_json::from_str(&json_m).unwrap();
        assert_eq!(parsed_m["url"], "https://t.co/abc");
        assert_eq!(parsed_m["merchant_url"], "https://hxdev.id");
    }

    #[test]
    fn test_cta_copy_button() {
        let btn = Button::copy("Salin OTP", "981240");
        assert_eq!(btn.name(), BUTTON_NAME_CTA_COPY);

        let json_str = btn.to_params_json();
        let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();
        assert_eq!(parsed["display_text"], "Salin OTP");
        assert_eq!(parsed["copy_code"], "981240");

        let nfb = btn.to_native_flow_button();
        let wire = nfb.to_wire_bytes();
        let decoded = NativeFlowButton::from_wire_bytes(&wire).unwrap();
        assert_eq!(decoded.name, "cta_copy");
        assert_eq!(decoded.button_params_json, json_str);
    }

    #[test]
    fn test_native_flow_response_parse() {
        let resp = NativeFlowResponse::parse(r#"{"id":"opt_agree","display_text":"Agree"}"#).unwrap();
        assert_eq!(resp.selected_id.as_deref(), Some("opt_agree"));
        assert_eq!(resp.display_text.as_deref(), Some("Agree"));

        let resp2 = NativeFlowResponse::parse(r#"{"selected_id":"opt_2"}"#).unwrap();
        assert_eq!(resp2.selected_id.as_deref(), Some("opt_2"));
    }
}
