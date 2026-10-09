// [xihanzu-NR]
//! WhatsApp Binary XML Stanza and Protobuf bridge for zapapp.
//! Mirrors zapo's transport/binary and protocol stanza builders.

pub mod node;
pub mod stanza;
pub mod tokens;

pub use node::{
    decode_binary_node, decode_binary_node_stanza, encode_binary_node, encode_binary_node_stanza,
    BinaryNode, BinaryNodeContent, ByteReader, ByteWriter, NodeAttrs, ProtoError,
};
pub use stanza::{
    build_biz_node, build_button_addon_node, build_delivery_receipt,
    build_direct_message_fanout_node, build_enc_node, build_encrypted_to_node,
    build_encrypted_to_nodes, build_group_retry_message_node, build_group_sender_key_message_node,
    build_iq_error, build_iq_ping, build_iq_query, build_iq_result, build_played_receipt,
    build_read_receipt, build_retry_receipt, extract_enc_payload, pad_random_max_16, unpad_pkcs7,
    wrap_proto_message_stanza, ButtonAddonKind, EncryptedParticipant, MessageAttrs,
    ProtoWireReader, ProtoWireWriter, ENC_TYPE_MSG, ENC_TYPE_MSMSG, ENC_TYPE_PKMSG,
    ENC_TYPE_SKMSG, IQ_TYPE_ERROR, IQ_TYPE_GET, IQ_TYPE_RESULT, IQ_TYPE_SET,
    RECEIPT_TYPE_DELIVERY, RECEIPT_TYPE_PEER, RECEIPT_TYPE_PLAYED, RECEIPT_TYPE_READ,
    RECEIPT_TYPE_RETRY, RECEIPT_TYPE_SERVER_ERROR, TAG_ACK, TAG_BIZ, TAG_ENC, TAG_ERROR, TAG_IQ,
    TAG_MESSAGE, TAG_RECEIPT,
};
pub use tokens::{
    find_token, get_dict_token, get_single_byte_token, DICTIONARIES, DICT_VERSION,
    SINGLE_BYTE_TOKENS,
};
