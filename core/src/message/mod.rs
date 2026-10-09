// [xihanzu-NR]
//! WhatsApp Interactive Native Flow Messages and ViewOnce Wrapper.
//! Mirrors zapo's button addon stanzas, native flow buttons, and viewOnceMessage envelope.

pub mod builder;
pub mod buttons;

pub use builder::{
    build_button_addon_node, build_interactive_button_addon_node, inspect_interactive_message,
    is_view_once, unwrap_view_once, wrap_as_view_once, wrap_as_view_once_v2,
    InteractiveMessageBuilder, ParsedInteractiveMessage, FIELD_FUTURE_PROOF_MESSAGE,
    FIELD_INTERACTIVE_MESSAGE, FIELD_VIEW_ONCE_MESSAGE, FIELD_VIEW_ONCE_MESSAGE_V2,
};
pub use buttons::{
    Button, NativeFlowButton, NativeFlowResponse, BUTTON_NAME_CTA_COPY, BUTTON_NAME_CTA_URL,
    BUTTON_NAME_QUICK_REPLY,
};
