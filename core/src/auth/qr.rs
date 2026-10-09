// [xihanzu-NR]
//! WhatsApp QR Code Matrix Generator, Parser, SVG / Data URL Renderer,
//! and Companion Pairing Payload Protocol.

use std::fmt::Write as FmtWrite;

/// Supported QR error correction levels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QrEcLevel {
    /// Low (~7% recovery)
    L,
    /// Medium (~15% recovery)
    M,
}

/// Errors occurring during QR matrix operations, encoding, or parsing.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum QrError {
    #[error("Invalid matrix dimensions: {0}")]
    InvalidDimensions(String),

    #[error("Invalid matrix character '{0}' at line {1}, col {2}")]
    InvalidMatrixChar(char, usize, usize),

    #[error("Empty matrix")]
    EmptyMatrix,

    #[error("Non-uniform row lengths: expected {expected}, got {actual} at row {row}")]
    NonUniformRows {
        expected: usize,
        actual: usize,
        row: usize,
    },

    #[error("Payload encoding error: {0}")]
    EncodingError(String),

    #[error("Payload decoding error: {0}")]
    DecodingError(String),

    #[error("Data too large for QR code (len: {len}, max: {max})")]
    DataTooLarge { len: usize, max: usize },

    #[error("Invalid QR pairing string format: {0}")]
    InvalidPairingFormat(String),

    #[error("Invalid key length: expected {expected}, got {actual}")]
    InvalidKeyLength { expected: usize, actual: usize },
}

// ---------------------------------------------------------------------------
// Base64 RFC 4648 Helper (Zero-dependency, URL-safe and standard)
// ---------------------------------------------------------------------------

const B64_CHARS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Encodes byte slice to standard Base64 string with padding.
pub fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = if chunk.len() > 1 { chunk[1] } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] } else { 0 };

        let idx0 = (b0 >> 2) as usize;
        let idx1 = (((b0 & 0x03) << 4) | (b1 >> 4)) as usize;
        let idx2 = (((b1 & 0x0f) << 2) | (b2 >> 6)) as usize;
        let idx3 = (b2 & 0x3f) as usize;

        out.push(B64_CHARS[idx0] as char);
        out.push(B64_CHARS[idx1] as char);
        if chunk.len() > 1 {
            out.push(B64_CHARS[idx2] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(B64_CHARS[idx3] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// Decodes standard or URL-safe Base64 string to bytes.
pub fn base64_decode(input: &str) -> Result<Vec<u8>, QrError> {
    let s: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if s.is_empty() {
        return Ok(Vec::new());
    }
    if s.len() % 4 != 0 {
        return Err(QrError::DecodingError(format!(
            "Invalid base64 length: {}",
            s.len()
        )));
    }

    fn decode_char(b: u8) -> Result<u8, QrError> {
        match b {
            b'A'..=b'Z' => Ok(b - b'A'),
            b'a'..=b'z' => Ok(b - b'a' + 26),
            b'0'..=b'9' => Ok(b - b'0' + 52),
            b'+' | b'-' => Ok(62),
            b'/' | b'_' => Ok(63),
            b'=' => Ok(0),
            _ => Err(QrError::DecodingError(format!(
                "Invalid base64 byte: 0x{:02x}",
                b
            ))),
        }
    }

    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    for chunk in s.chunks(4) {
        let c0 = decode_char(chunk[0])?;
        let c1 = decode_char(chunk[1])?;
        out.push((c0 << 2) | (c1 >> 4));

        if chunk[2] != b'=' {
            let c2 = decode_char(chunk[2])?;
            out.push(((c1 & 0x0f) << 4) | (c2 >> 2));

            if chunk[3] != b'=' {
                let c3 = decode_char(chunk[3])?;
                out.push(((c2 & 0x03) << 6) | c3);
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// SVG Rendering Options
// ---------------------------------------------------------------------------

/// Options controlling SVG and Data URL rendering of a QR matrix.
#[derive(Clone, Debug, PartialEq)]
pub struct SvgOptions {
    /// Pixel size per module (default: 8).
    pub module_size: usize,
    /// Quiet zone margin in modules around the QR code (default: 4).
    pub margin: usize,
    /// Foreground / dark module color (e.g. "#000000").
    pub foreground_color: String,
    /// Background color (e.g. "#ffffff" or "transparent").
    pub background_color: String,
    /// Whether to include the <?xml ...?> declaration header.
    pub include_xml_header: bool,
}

impl Default for SvgOptions {
    fn default() -> Self {
        Self {
            module_size: 8,
            margin: 4,
            foreground_color: "#000000".to_string(),
            background_color: "#ffffff".to_string(),
            include_xml_header: false,
        }
    }
}

// ---------------------------------------------------------------------------
// 2D QR Code Matrix
// ---------------------------------------------------------------------------

/// Represents a 2-dimensional boolean QR code matrix (true = dark, false = light).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QrMatrix {
    pub width: usize,
    pub height: usize,
    pub modules: Vec<bool>,
}

impl QrMatrix {
    /// Creates a new matrix initialized to all light modules (false).
    pub fn new(width: usize, height: usize) -> Self {
        Self {
            width,
            height,
            modules: vec![false; width * height],
        }
    }

    /// Creates a matrix from pre-existing module buffer.
    pub fn from_modules(width: usize, height: usize, modules: Vec<bool>) -> Result<Self, QrError> {
        if modules.len() != width * height {
            return Err(QrError::InvalidDimensions(format!(
                "Module count {} does not match dimensions {}x{}",
                modules.len(),
                width,
                height
            )));
        }
        Ok(Self {
            width,
            height,
            modules,
        })
    }

    /// Creates a matrix from a 2D boolean grid `[row][col]`.
    pub fn from_bool_grid(grid: &[Vec<bool>]) -> Result<Self, QrError> {
        let height = grid.len();
        if height == 0 {
            return Err(QrError::EmptyMatrix);
        }
        let width = grid[0].len();
        if width == 0 {
            return Err(QrError::EmptyMatrix);
        }

        let mut modules = Vec::with_capacity(width * height);
        for (r, row) in grid.iter().enumerate() {
            if row.len() != width {
                return Err(QrError::NonUniformRows {
                    expected: width,
                    actual: row.len(),
                    row: r,
                });
            }
            modules.extend_from_slice(row);
        }
        Ok(Self {
            width,
            height,
            modules,
        })
    }

    /// Gets module at coordinate (x, y). Returns false if out of bounds.
    pub fn get(&self, x: usize, y: usize) -> bool {
        if x < self.width && y < self.height {
            self.modules[y * self.width + x]
        } else {
            false
        }
    }

    /// Sets module at coordinate (x, y).
    pub fn set(&mut self, x: usize, y: usize, value: bool) {
        if x < self.width && y < self.height {
            self.modules[y * self.width + x] = value;
        }
    }

    /// Parses an ASCII / string matrix representation into a `QrMatrix`.
    ///
    /// Supports:
    /// - Binary lines: `'1'` (dark) / `'0'` (light)
    /// - Punctuation lines: `'#'`, `'X'`, `'*'` (dark) / `'.'`,`'-'`,`' '` (light)
    /// - Unicode block symbols: `'█'`, `'■'` (dark) / `' '`, `'░'`, `'□'` (light)
    /// - Double-width terminal blocks: automatically detects `"██"` and `"  "` terminal pairs
    pub fn from_matrix_string(input: &str) -> Result<Self, QrError> {
        let lines: Vec<&str> = input
            .lines()
            .map(|l| l.trim_end_matches(['\r', '\n']))
            .filter(|l| !l.is_empty())
            .collect();

        if lines.is_empty() {
            return Err(QrError::EmptyMatrix);
        }

        // Check if double-width character representation is used (e.g. terminal pairs "██" / "  ")
        let is_double_width = lines.iter().all(|line| {
            let chars: Vec<char> = line.chars().collect();
            chars.len() >= 2
                && chars.len() % 2 == 0
                && chars.chunks(2).all(|c| c[0] == c[1])
        });

        let mut grid: Vec<Vec<bool>> = Vec::with_capacity(lines.len());
        for (row_idx, line) in lines.iter().enumerate() {
            let chars: Vec<char> = line.chars().collect();
            let mut row = Vec::new();

            let step = if is_double_width { 2 } else { 1 };
            let mut i = 0;
            while i < chars.len() {
                let ch = chars[i];
                let is_dark = match ch {
                    '1' | '#' | 'X' | 'x' | '*' | '█' | '■' | '@' => true,
                    '0' | '.' | '-' | '_' | ' ' | '□' | '░' => false,
                    other => {
                        return Err(QrError::InvalidMatrixChar(other, row_idx + 1, i + 1));
                    }
                };
                row.push(is_dark);
                i += step;
            }
            grid.push(row);
        }

        // Pad shorter lines with false (light) modules in case trailing whitespace was trimmed
        let max_len = grid.iter().map(|r| r.len()).max().unwrap_or(0);
        for row in &mut grid {
            while row.len() < max_len {
                row.push(false);
            }
        }

        Self::from_bool_grid(&grid)
    }

    /// Renders the matrix into a UTF-8 ASCII block string for terminal display.
    pub fn to_ascii_string(&self) -> String {
        let mut out = String::with_capacity((self.width * 2 + 1) * self.height);
        for y in 0..self.height {
            for x in 0..self.width {
                if self.get(x, y) {
                    out.push_str("██");
                } else {
                    out.push_str("  ");
                }
            }
            out.push('\n');
        }
        out
    }

    /// Generates vector SVG XML markup.
    pub fn to_svg(&self, options: &SvgOptions) -> String {
        let mod_size = options.module_size.max(1);
        let margin = options.margin;
        let total_width = (self.width + 2 * margin) * mod_size;
        let total_height = (self.height + 2 * margin) * mod_size;

        let mut svg = String::new();
        if options.include_xml_header {
            svg.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
        }
        let _ = write!(
            &mut svg,
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {0} {1}" width="{0}" height="{1}" shape-rendering="crispEdges">"#,
            total_width, total_height
        );

        if !options.background_color.is_empty() && options.background_color != "transparent" {
            let _ = write!(
                &mut svg,
                r#"<rect width="100%" height="100%" fill="{}"/>"#,
                options.background_color
            );
        }

        let mut path_data = String::new();
        for y in 0..self.height {
            for x in 0..self.width {
                if self.get(x, y) {
                    let px = (x + margin) * mod_size;
                    let py = (y + margin) * mod_size;
                    let _ = write!(
                        &mut path_data,
                        "M{} {}h{}v{}h-{}z ",
                        px, py, mod_size, mod_size, mod_size
                    );
                }
            }
        }

        if !path_data.is_empty() {
            let _ = write!(
                &mut svg,
                r#"<path d="{}" fill="{}"/>"#,
                path_data.trim_end(),
                options.foreground_color
            );
        }

        svg.push_str("</svg>");
        svg
    }

    /// Generates a `data:image/svg+xml;base64,...` Data URL.
    pub fn to_data_url(&self, options: &SvgOptions) -> String {
        let svg = self.to_svg(options);
        format!(
            "data:image/svg+xml;base64,{}",
            base64_encode(svg.as_bytes())
        )
    }

    /// Generates a `data:image/svg+xml;utf8,...` Data URL.
    pub fn to_data_url_utf8(&self, options: &SvgOptions) -> String {
        let svg = self.to_svg(options);
        let encoded = svg
            .replace('%', "%25")
            .replace('#', "%23")
            .replace('<', "%3C")
            .replace('>', "%3E")
            .replace('"', "%22")
            .replace(' ', "%20");
        format!("data:image/svg+xml;utf8,{}", encoded)
    }
}

// ---------------------------------------------------------------------------
// QR Code Encoder (ISO/IEC 18004 Byte Mode, Versions 1-10)
// ---------------------------------------------------------------------------

struct GaloisField {
    exp: [u8; 512],
    log: [u8; 256],
}

impl GaloisField {
    fn new() -> Self {
        let mut exp = [0u8; 512];
        let mut log = [0u8; 256];
        let mut x = 1u16;
        for i in 0..255 {
            exp[i] = x as u8;
            exp[i + 255] = x as u8;
            log[x as usize] = i as u8;
            x <<= 1;
            if (x & 0x100) != 0 {
                x ^= 0x11D;
            }
        }
        GaloisField { exp, log }
    }

    fn mul(&self, a: u8, b: u8) -> u8 {
        if a == 0 || b == 0 {
            0
        } else {
            let idx = (self.log[a as usize] as usize) + (self.log[b as usize] as usize);
            self.exp[idx]
        }
    }
}

fn rs_generator_poly(gf: &GaloisField, degree: usize) -> Vec<u8> {
    let mut g = vec![1u8];
    for i in 0..degree {
        let root = gf.exp[i];
        let mut next = vec![0u8; g.len() + 1];
        for (j, &coeff) in g.iter().enumerate() {
            next[j] ^= coeff;
            next[j + 1] ^= gf.mul(coeff, root);
        }
        g = next;
    }
    g
}

fn rs_encode(gf: &GaloisField, data: &[u8], ec_len: usize) -> Vec<u8> {
    let gen = rs_generator_poly(gf, ec_len);
    let mut remainder = vec![0u8; ec_len];
    for &b in data {
        let factor = b ^ remainder[0];
        remainder.drain(0..1);
        remainder.push(0);
        if factor != 0 {
            for (r, &g) in remainder.iter_mut().zip(&gen[1..]) {
                *r ^= gf.mul(g, factor);
            }
        }
    }
    remainder
}

#[derive(Clone, Copy)]
struct QrVersionSpec {
    version: usize,
    total_codewords: usize,
    data_codewords: usize,
    ec_codewords_per_block: usize,
    num_blocks: usize,
    align_centers: &'static [usize],
}

static VERSION_SPECS_L: &[QrVersionSpec] = &[
    QrVersionSpec {
        version: 1,
        total_codewords: 26,
        data_codewords: 19,
        ec_codewords_per_block: 7,
        num_blocks: 1,
        align_centers: &[],
    },
    QrVersionSpec {
        version: 2,
        total_codewords: 44,
        data_codewords: 34,
        ec_codewords_per_block: 10,
        num_blocks: 1,
        align_centers: &[6, 18],
    },
    QrVersionSpec {
        version: 3,
        total_codewords: 70,
        data_codewords: 55,
        ec_codewords_per_block: 15,
        num_blocks: 1,
        align_centers: &[6, 22],
    },
    QrVersionSpec {
        version: 4,
        total_codewords: 100,
        data_codewords: 80,
        ec_codewords_per_block: 20,
        num_blocks: 1,
        align_centers: &[6, 26],
    },
    QrVersionSpec {
        version: 5,
        total_codewords: 134,
        data_codewords: 108,
        ec_codewords_per_block: 26,
        num_blocks: 1,
        align_centers: &[6, 30],
    },
    QrVersionSpec {
        version: 6,
        total_codewords: 172,
        data_codewords: 136,
        ec_codewords_per_block: 18,
        num_blocks: 2,
        align_centers: &[6, 34],
    },
    QrVersionSpec {
        version: 7,
        total_codewords: 196,
        data_codewords: 156,
        ec_codewords_per_block: 20,
        num_blocks: 2,
        align_centers: &[6, 22, 38],
    },
    QrVersionSpec {
        version: 8,
        total_codewords: 242,
        data_codewords: 194,
        ec_codewords_per_block: 24,
        num_blocks: 2,
        align_centers: &[6, 24, 42],
    },
    QrVersionSpec {
        version: 9,
        total_codewords: 292,
        data_codewords: 232,
        ec_codewords_per_block: 30,
        num_blocks: 2,
        align_centers: &[6, 26, 46],
    },
    QrVersionSpec {
        version: 10,
        total_codewords: 346,
        data_codewords: 274,
        ec_codewords_per_block: 36,
        num_blocks: 2,
        align_centers: &[6, 28, 50],
    },
];

// Format info strings for Level L and mask pattern 0 (0x77c4)
const FORMAT_INFO_L_MASK0: u16 = 0x77c4;

/// Encodes binary data or text into a `QrMatrix` (QR Version 1..10, Level L).
pub fn encode_to_matrix(data: &[u8]) -> Result<QrMatrix, QrError> {
    let gf = GaloisField::new();

    // Find smallest version that accommodates the data length
    // Overhead: 4 bits mode + 8/16 bits char count = ~2-3 bytes
    let required_data_bytes = data.len() + 2;
    let spec = VERSION_SPECS_L
        .iter()
        .find(|s| s.data_codewords >= required_data_bytes)
        .ok_or_else(|| QrError::DataTooLarge {
            len: data.len(),
            max: 271,
        })?;

    let version = spec.version;
    let size = version * 4 + 17;

    // 1. Bitstream assembly (Byte mode: indicator 0100)
    let mut bitstream = Vec::new();
    let push_bits = |stream: &mut Vec<bool>, val: u32, count: usize| {
        for i in (0..count).rev() {
            stream.push(((val >> i) & 1) == 1);
        }
    };

    // Mode: Byte (0100)
    push_bits(&mut bitstream, 0b0100, 4);

    // Character count indicator: 8 bits for versions 1..9, 16 bits for version 10
    let count_bits = if version < 10 { 8 } else { 16 };
    push_bits(&mut bitstream, data.len() as u32, count_bits);

    // Data payload
    for &b in data {
        push_bits(&mut bitstream, b as u32, 8);
    }

    // Terminator (up to 4 zeroes)
    let max_data_bits = spec.data_codewords * 8;
    let term_len = (max_data_bits - bitstream.len()).min(4);
    for _ in 0..term_len {
        bitstream.push(false);
    }

    // Pad to byte boundary
    while bitstream.len() % 8 != 0 {
        bitstream.push(false);
    }

    // Pack into bytes
    let mut data_codewords = Vec::with_capacity(spec.data_codewords);
    for chunk in bitstream.chunks(8) {
        let mut byte = 0u8;
        for &bit in chunk {
            byte = (byte << 1) | (bit as u8);
        }
        data_codewords.push(byte);
    }

    // Fill remaining capacity with 0xEC / 0x11 pad codewords
    let mut pad = 0xECu8;
    while data_codewords.len() < spec.data_codewords {
        data_codewords.push(pad);
        pad = if pad == 0xEC { 0x11 } else { 0xEC };
    }

    // 2. Error Correction Codewords computation
    let block_data_len = spec.data_codewords / spec.num_blocks;
    let mut all_data_blocks = Vec::with_capacity(spec.num_blocks);
    let mut all_ec_blocks = Vec::with_capacity(spec.num_blocks);

    for b in 0..spec.num_blocks {
        let start = b * block_data_len;
        let end = if b == spec.num_blocks - 1 {
            spec.data_codewords
        } else {
            start + block_data_len
        };
        let block_slice = &data_codewords[start..end];
        let ec_block = rs_encode(&gf, block_slice, spec.ec_codewords_per_block);
        all_data_blocks.push(block_slice.to_vec());
        all_ec_blocks.push(ec_block);
    }

    // Interleave data codewords
    let mut final_codewords = Vec::with_capacity(spec.total_codewords);
    let max_block_len = all_data_blocks.iter().map(|b| b.len()).max().unwrap_or(0);
    for i in 0..max_block_len {
        for block in &all_data_blocks {
            if i < block.len() {
                final_codewords.push(block[i]);
            }
        }
    }

    // Interleave EC codewords
    for i in 0..spec.ec_codewords_per_block {
        for block in &all_ec_blocks {
            if i < block.len() {
                final_codewords.push(block[i]);
            }
        }
    }

    // Convert final codewords into bit sequence
    let mut final_bits = Vec::with_capacity(final_codewords.len() * 8);
    for &cw in &final_codewords {
        for i in (0..8).rev() {
            final_bits.push(((cw >> i) & 1) == 1);
        }
    }

    // 3. Construct Matrix
    let mut matrix = QrMatrix::new(size, size);
    let mut reserved = vec![vec![false; size]; size];

    // Helper: mark function module
    let mark_fn = |m: &mut QrMatrix, r: &mut Vec<Vec<bool>>, x: usize, y: usize, val: bool| {
        m.set(x, y, val);
        r[y][x] = true;
    };

    // Draw Finder Patterns (7x7) + Separators
    let draw_finder =
        |m: &mut QrMatrix, r: &mut Vec<Vec<bool>>, ox: usize, oy: usize| {
            for dy in 0..7 {
                for dx in 0..7 {
                    let is_border = dx == 0 || dx == 6 || dy == 0 || dy == 6;
                    let is_center = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
                    let val = is_border || is_center;
                    m.set(ox + dx, oy + dy, val);
                    r[oy + dy][ox + dx] = true;
                }
            }
            // Separator border (8x8)
            for dy in 0..=7 {
                for dx in 0..=7 {
                    let x = ox.wrapping_add(dx);
                    let y = oy.wrapping_add(dy);
                    if x < size && y < size && !r[y][x] {
                        m.set(x, y, false);
                        r[y][x] = true;
                    }
                }
            }
        };

    draw_finder(&mut matrix, &mut reserved, 0, 0);
    draw_finder(&mut matrix, &mut reserved, size - 7, 0);
    draw_finder(&mut matrix, &mut reserved, 0, size - 7);

    // Separators for top-right and bottom-left
    for y in 0..8 {
        if size >= 8 {
            reserved[y][size - 8] = true;
            matrix.set(size - 8, y, false);
        }
    }
    for x in 0..8 {
        if size >= 8 {
            reserved[size - 8][x] = true;
            matrix.set(x, size - 8, false);
        }
    }

    // Timing patterns: alternating black/white on row 6 and col 6
    for i in 8..size - 8 {
        let val = (i % 2) == 0;
        mark_fn(&mut matrix, &mut reserved, i, 6, val);
        mark_fn(&mut matrix, &mut reserved, 6, i, val);
    }

    // Alignment patterns (for version >= 2)
    if version >= 2 {
        let coords = spec.align_centers;
        for &cy in coords {
            for &cx in coords {
                // Skip if overlapping with finder patterns
                let near_tl = cx <= 8 && cy <= 8;
                let near_tr = cx >= size - 8 && cy <= 8;
                let near_bl = cx <= 8 && cy >= size - 8;
                if near_tl || near_tr || near_bl {
                    continue;
                }

                for dy in 0..5 {
                    for dx in 0..5 {
                        let px = cx + dx - 2;
                        let py = cy + dy - 2;
                        let is_border = dx == 0 || dx == 4 || dy == 0 || dy == 4;
                        let is_center = dx == 2 && dy == 2;
                        let val = is_border || is_center;
                        mark_fn(&mut matrix, &mut reserved, px, py, val);
                    }
                }
            }
        }
    }

    // Dark module: (8, 4 * version + 9) -> (8, size - 8)
    mark_fn(&mut matrix, &mut reserved, 8, size - 8, true);

    // Reserve format information modules
    for i in 0..9 {
        if i != 6 {
            reserved[8][i] = true;
            reserved[i][8] = true;
        }
    }
    for i in 0..8 {
        reserved[8][size - 1 - i] = true;
        reserved[size - 1 - i][8] = true;
    }

    // 4. Place Data Bits with Mask 0: (row + col) % 2 == 0
    let mut bit_idx = 0;
    let mut upward = true;
    let mut col = size as isize - 1;

    while col > 0 {
        if col == 6 {
            col -= 1; // Skip vertical timing pattern column
        }

        let rows: Vec<usize> = if upward {
            (0..size).rev().collect()
        } else {
            (0..size).collect()
        };

        for row in rows {
            for &c in &[col as usize, (col - 1) as usize] {
                if !reserved[row][c] {
                    let mut bit = if bit_idx < final_bits.len() {
                        final_bits[bit_idx]
                    } else {
                        false
                    };
                    bit_idx += 1;

                    // Apply Mask Pattern 0: (row + col) % 2 == 0
                    if (row + c) % 2 == 0 {
                        bit = !bit;
                    }
                    matrix.set(c, row, bit);
                }
            }
        }
        upward = !upward;
        col -= 2;
    }

    // 5. Place Format Information (Level L, Mask 0)
    let format_bits = FORMAT_INFO_L_MASK0;
    for i in 0..15 {
        let bit = ((format_bits >> (14 - i)) & 1) == 1;
        // Top-left placement
        let (x, y) = if i < 6 {
            (i, 8)
        } else if i < 8 {
            (i + 1, 8)
        } else if i == 8 {
            (8, 7)
        } else {
            (8, 14 - i)
        };
        matrix.set(x, y, bit);

        // Split placement near TR and BL
        let (x2, y2) = if i < 8 {
            (8, size - 1 - i)
        } else {
            (size - 15 + i, 8)
        };
        matrix.set(x2, y2, bit);
    }

    Ok(matrix)
}

// ---------------------------------------------------------------------------
// WhatsApp QR Companion Pairing Payload
// ---------------------------------------------------------------------------

/// Parsed WhatsApp Multi-Device QR Code pairing payload.
/// Format: `ref,noise_public_key_b64,identity_public_key_b64,adv_secret_b64`
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QrPairingPayload {
    /// Server session reference string (e.g. "1@abc...").
    pub ref_id: String,
    /// 32-byte Noise public key.
    pub noise_public_key: [u8; 32],
    /// 32-byte Ed25519 Identity public key.
    pub identity_public_key: [u8; 32],
    /// Optional 32-byte ADV secret key.
    pub adv_secret_key: Option<[u8; 32]>,
}

impl QrPairingPayload {
    /// Creates a new pairing payload.
    pub fn new(
        ref_id: String,
        noise_public_key: [u8; 32],
        identity_public_key: [u8; 32],
        adv_secret_key: Option<[u8; 32]>,
    ) -> Self {
        Self {
            ref_id,
            noise_public_key,
            identity_public_key,
            adv_secret_key,
        }
    }

    /// Parses a comma-separated QR pairing string:
    /// `"ref,noise_pub_b64,identity_pub_b64,adv_secret_b64"`
    pub fn parse(qr_string: &str) -> Result<Self, QrError> {
        let parts: Vec<&str> = qr_string.split(',').collect();
        if parts.len() < 3 {
            return Err(QrError::InvalidPairingFormat(format!(
                "Expected at least 3 comma-separated components, got {}",
                parts.len()
            )));
        }

        let ref_id = parts[0].trim().to_string();
        if ref_id.is_empty() {
            return Err(QrError::InvalidPairingFormat(
                "Ref ID cannot be empty".to_string(),
            ));
        }

        let noise_bytes = base64_decode(parts[1])?;
        if noise_bytes.len() != 32 {
            return Err(QrError::InvalidKeyLength {
                expected: 32,
                actual: noise_bytes.len(),
            });
        }
        let mut noise_public_key = [0u8; 32];
        noise_public_key.copy_from_slice(&noise_bytes);

        let id_bytes = base64_decode(parts[2])?;
        if id_bytes.len() != 32 {
            return Err(QrError::InvalidKeyLength {
                expected: 32,
                actual: id_bytes.len(),
            });
        }
        let mut identity_public_key = [0u8; 32];
        identity_public_key.copy_from_slice(&id_bytes);

        let adv_secret_key = if parts.len() > 3 && !parts[3].trim().is_empty() {
            let adv_bytes = base64_decode(parts[3])?;
            if adv_bytes.len() != 32 {
                return Err(QrError::InvalidKeyLength {
                    expected: 32,
                    actual: adv_bytes.len(),
                });
            }
            let mut adv = [0u8; 32];
            adv.copy_from_slice(&adv_bytes);
            Some(adv)
        } else {
            None
        };

        Ok(Self {
            ref_id,
            noise_public_key,
            identity_public_key,
            adv_secret_key,
        })
    }

    /// Serializes to the standard WhatsApp QR pairing string.
    pub fn to_qr_string(&self) -> String {
        let noise_b64 = base64_encode(&self.noise_public_key);
        let id_b64 = base64_encode(&self.identity_public_key);
        if let Some(adv) = &self.adv_secret_key {
            let adv_b64 = base64_encode(adv);
            format!("{},{},{},{}", self.ref_id, noise_b64, id_b64, adv_b64)
        } else {
            format!("{},{},{}", self.ref_id, noise_b64, id_b64)
        }
    }

    /// Generates a `QrMatrix` directly from this payload.
    pub fn to_matrix(&self) -> Result<QrMatrix, QrError> {
        let qr_str = self.to_qr_string();
        encode_to_matrix(qr_str.as_bytes())
    }

    /// Generates SVG markup for this pairing payload.
    pub fn to_svg(&self, options: &SvgOptions) -> Result<String, QrError> {
        let matrix = self.to_matrix()?;
        Ok(matrix.to_svg(options))
    }

    /// Generates base64 SVG Data URL for this pairing payload.
    pub fn to_data_url(&self, options: &SvgOptions) -> Result<String, QrError> {
        let matrix = self.to_matrix()?;
        Ok(matrix.to_data_url(options))
    }
}

// ---------------------------------------------------------------------------
// Unit Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_base64_roundtrip() {
        let cases = vec![
            b"".to_vec(),
            b"f".to_vec(),
            b"fo".to_vec(),
            b"foo".to_vec(),
            b"foob".to_vec(),
            b"fooba".to_vec(),
            b"foobar".to_vec(),
            (0u8..32).collect::<Vec<u8>>(),
        ];

        for case in cases {
            let encoded = base64_encode(&case);
            let decoded = base64_decode(&encoded).expect("decode failed");
            assert_eq!(decoded, case);
        }
    }

    #[test]
    fn test_matrix_from_string_binary() {
        let matrix_str = "\
101
010
101";
        let matrix = QrMatrix::from_matrix_string(matrix_str).unwrap();
        assert_eq!(matrix.width, 3);
        assert_eq!(matrix.height, 3);
        assert!(matrix.get(0, 0));
        assert!(!matrix.get(1, 0));
        assert!(matrix.get(2, 0));
        assert!(!matrix.get(0, 1));
        assert!(matrix.get(1, 1));
    }

    #[test]
    fn test_matrix_from_string_terminal_double_blocks() {
        let matrix_str = "\
██  ██
  ██
██  ██";
        let matrix = QrMatrix::from_matrix_string(matrix_str).unwrap();
        assert_eq!(matrix.width, 3);
        assert_eq!(matrix.height, 3);
        assert!(matrix.get(0, 0));
        assert!(!matrix.get(1, 0));
        assert!(matrix.get(2, 0));
    }

    #[test]
    fn test_matrix_svg_and_data_url() {
        let matrix = QrMatrix::from_matrix_string("10\n01").unwrap();
        let options = SvgOptions {
            module_size: 10,
            margin: 2,
            foreground_color: "#128C7E".to_string(),
            background_color: "#FFFFFF".to_string(),
            include_xml_header: true,
        };

        let svg = matrix.to_svg(&options);
        assert!(svg.contains("<svg"));
        assert!(svg.contains("viewBox=\"0 0 60 60\""));
        assert!(svg.contains("fill=\"#128C7E\""));

        let data_url = matrix.to_data_url(&options);
        assert!(data_url.starts_with("data:image/svg+xml;base64,"));
    }

    #[test]
    fn test_qr_pairing_payload_parse_and_format() {
        let ref_id = "1@testing_qr_token_abc123";
        let noise_key = [0x42u8; 32];
        let id_key = [0x77u8; 32];
        let adv_key = [0x99u8; 32];

        let payload = QrPairingPayload::new(
            ref_id.to_string(),
            noise_key,
            id_key,
            Some(adv_key),
        );

        let qr_string = payload.to_qr_string();
        assert!(qr_string.starts_with(ref_id));

        let parsed = QrPairingPayload::parse(&qr_string).unwrap();
        assert_eq!(parsed, payload);
    }

    #[test]
    fn test_qr_encoder_generation() {
        let data = b"https://whatsapp.com";
        let matrix = encode_to_matrix(data).unwrap();

        // Size should be at least version 1 (21x21)
        assert!(matrix.width >= 21);
        assert_eq!(matrix.width, matrix.height);

        // Top-left finder center (3,3) must be dark
        assert!(matrix.get(3, 3));
        // Separator at (7,7) must be light
        assert!(!matrix.get(7, 7));

        let svg = matrix.to_svg(&SvgOptions::default());
        assert!(svg.contains("<svg"));
    }
}
