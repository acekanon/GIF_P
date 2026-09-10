//! Bounded, dependency-free inspection of RIFF WebP container metadata.
//!
//! The parser deliberately stops at the container/bitstream-header boundary: it
//! validates chunk layout and extracts dimensions, animation timing, looping,
//! alpha signalling, and background colour without decoding pixels.

use std::error::Error;
use std::fmt;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

const RIFF: [u8; 4] = *b"RIFF";
const WEBP: [u8; 4] = *b"WEBP";
const VP8X: [u8; 4] = *b"VP8X";
const ANIM: [u8; 4] = *b"ANIM";
const ANMF: [u8; 4] = *b"ANMF";
const ALPH: [u8; 4] = *b"ALPH";
const VP8: [u8; 4] = *b"VP8 ";
const VP8L: [u8; 4] = *b"VP8L";
#[cfg(test)]
const ICCP: [u8; 4] = *b"ICCP";
#[cfg(test)]
const EXIF: [u8; 4] = *b"EXIF";
#[cfg(test)]
const XMP: [u8; 4] = *b"XMP ";

const VP8X_FLAG_ANIMATION: u8 = 0x02;
#[cfg(test)]
const VP8X_FLAG_XMP: u8 = 0x04;
#[cfg(test)]
const VP8X_FLAG_EXIF: u8 = 0x08;
const VP8X_FLAG_ALPHA: u8 = 0x10;
#[cfg(test)]
const VP8X_FLAG_ICC: u8 = 0x20;
const VP8X_RESERVED_FLAGS: u8 = 0xc1;

/// FFmpeg 9's stock `webp_anim` minimum-delay default. GIFP overrides this to
/// zero so every positive duration is preserved.
#[cfg(test)]
pub const FFMPEG_9_DEFAULT_MIN_FRAME_DURATION_MS: u32 = 10;

/// GIFP's explicit FFmpeg 9 minimum-delay policy for Animated WebP input.
pub const GIFP_WEBP_MIN_FRAME_DURATION_MS: u32 = 0;

/// FFmpeg 9's default replacement for an encoded duration at or below
/// the selected minimum-delay threshold.
pub const FFMPEG_9_DEFAULT_FRAME_DURATION_MS: u32 = 100;

/// The ANIM background colour converted from its on-disk BGRA byte order.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WebpBackgroundColor {
    pub red: u8,
    pub green: u8,
    pub blue: u8,
    pub alpha: u8,
}

/// Metadata obtained without decoding WebP pixels.
#[cfg(test)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WebpContainerInfo {
    pub canvas_width: u32,
    pub canvas_height: u32,
    /// True when the VP8X animation feature is present, including a legal
    /// single-frame animation container.
    pub is_animated: bool,
    pub has_alpha: bool,
    pub frame_count: u64,
    /// Exact, unmodified 24-bit ANMF durations. Static WebP files have no ANMF
    /// duration fields, so this vector is empty for them.
    pub frame_durations_ms: Vec<u32>,
    /// The same timeline interpreted with GIFP's explicit FFmpeg 9
    /// `min_delay=0` and `default_delay=100` policy. No frame is removed.
    pub playback_frame_durations_ms: Vec<u32>,
    /// Sum of the exact encoded ANMF durations.
    pub encoded_total_duration_ms: u64,
    /// Sum of [`Self::playback_frame_durations_ms`].
    pub total_duration_ms: u64,
    /// Raw ANIM loop count (`0` means infinite). Static files return `None`.
    pub loop_count: Option<u16>,
    pub background_color: Option<WebpBackgroundColor>,
}

/// Exact Animated WebP timeline metadata gathered with constant memory.
///
/// Image payloads are skipped with seeks; only RIFF headers, VP8X, ANIM and the
/// fixed 16-byte prefix of every ANMF frame are read.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WebpAnimationSummary {
    pub canvas_width: u32,
    pub canvas_height: u32,
    pub has_alpha: bool,
    pub frame_count: u64,
    pub encoded_total_duration_ms: u64,
    pub playback_total_duration_ms: u64,
    pub loop_count: u16,
    pub background_color: WebpBackgroundColor,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WebpContainerError {
    HeaderTooShort {
        actual: usize,
    },
    InvalidRiffSignature,
    InvalidWebpSignature,
    InvalidRiffSize {
        declared_file_size: u64,
        actual_file_size: u64,
    },
    TruncatedChunkHeader {
        context: &'static str,
        offset: usize,
        available: usize,
    },
    ChunkSizeOverflow {
        chunk: [u8; 4],
        offset: usize,
    },
    TruncatedChunkPayload {
        context: &'static str,
        chunk: [u8; 4],
        offset: usize,
        declared_size: u32,
        available: usize,
    },
    NonZeroPadding {
        context: &'static str,
        chunk: [u8; 4],
        offset: usize,
    },
    DuplicateChunk {
        chunk: [u8; 4],
        offset: usize,
    },
    InvalidChunkOrder {
        chunk: [u8; 4],
        offset: usize,
        reason: &'static str,
    },
    InvalidChunkSize {
        chunk: [u8; 4],
        offset: usize,
        expected: usize,
        actual: usize,
    },
    InvalidReservedBits {
        chunk: [u8; 4],
        offset: usize,
        value: u8,
    },
    MissingChunk {
        chunk: [u8; 4],
        reason: &'static str,
    },
    #[cfg(test)]
    InvalidBitstreamHeader {
        chunk: [u8; 4],
        offset: usize,
        reason: &'static str,
    },
    #[cfg(test)]
    DimensionMismatch {
        chunk: [u8; 4],
        offset: usize,
        expected_width: u32,
        expected_height: u32,
        actual_width: u32,
        actual_height: u32,
    },
    FrameOutOfBounds {
        offset: usize,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        canvas_width: u32,
        canvas_height: u32,
    },
    FeatureFlagMismatch {
        chunk: [u8; 4],
        flag: &'static str,
    },
    CountOverflow,
    DurationOverflow,
}

impl fmt::Display for WebpContainerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::HeaderTooShort { actual } => {
                write!(formatter, "WebP RIFF header needs 12 bytes, found {actual}")
            }
            Self::InvalidRiffSignature => write!(formatter, "WebP file is missing the RIFF signature"),
            Self::InvalidWebpSignature => write!(formatter, "RIFF form type is not WEBP"),
            Self::InvalidRiffSize { declared_file_size, actual_file_size } => write!(
                formatter,
                "RIFF declares {declared_file_size} file bytes, found {actual_file_size}"
            ),
            Self::TruncatedChunkHeader { context, offset, available } => write!(
                formatter,
                "{context} chunk header at {offset} is truncated ({available} bytes remain)"
            ),
            Self::ChunkSizeOverflow { chunk, offset } => write!(
                formatter,
                "{} chunk size overflows its padded RIFF representation at {offset}",
                fourcc(*chunk)
            ),
            Self::TruncatedChunkPayload {
                context,
                chunk,
                offset,
                declared_size,
                available,
            } => write!(
                formatter,
                "{context} {} chunk at {offset} declares {declared_size} bytes, only {available} are available",
                fourcc(*chunk)
            ),
            Self::NonZeroPadding { context, chunk, offset } => write!(
                formatter,
                "{context} {} chunk has non-zero RIFF padding at {offset}",
                fourcc(*chunk)
            ),
            Self::DuplicateChunk { chunk, offset } => {
                write!(formatter, "duplicate {} chunk at {offset}", fourcc(*chunk))
            }
            Self::InvalidChunkOrder { chunk, offset, reason } => write!(
                formatter,
                "{} chunk at {offset} is out of order: {reason}",
                fourcc(*chunk)
            ),
            Self::InvalidChunkSize { chunk, offset, expected, actual } => write!(
                formatter,
                "{} chunk at {offset} has size {actual}, expected {expected}",
                fourcc(*chunk)
            ),
            Self::InvalidReservedBits { chunk, offset, value } => write!(
                formatter,
                "{} chunk at {offset} sets reserved bits/bytes (0x{value:02x})",
                fourcc(*chunk)
            ),
            Self::MissingChunk { chunk, reason } => {
                write!(formatter, "missing {} chunk: {reason}", fourcc(*chunk))
            }
            #[cfg(test)]
            Self::InvalidBitstreamHeader { chunk, offset, reason } => write!(
                formatter,
                "invalid {} bitstream header at {offset}: {reason}",
                fourcc(*chunk)
            ),
            #[cfg(test)]
            Self::DimensionMismatch {
                chunk,
                offset,
                expected_width,
                expected_height,
                actual_width,
                actual_height,
            } => write!(
                formatter,
                "{} dimensions {actual_width}x{actual_height} at {offset} do not match {expected_width}x{expected_height}",
                fourcc(*chunk)
            ),
            Self::FrameOutOfBounds {
                offset,
                x,
                y,
                width,
                height,
                canvas_width,
                canvas_height,
            } => write!(
                formatter,
                "ANMF rectangle {width}x{height}+{x}+{y} at {offset} exceeds {canvas_width}x{canvas_height} canvas"
            ),
            Self::FeatureFlagMismatch { chunk, flag } => write!(
                formatter,
                "{} chunk disagrees with the VP8X {flag} feature flag",
                fourcc(*chunk)
            ),
            Self::CountOverflow => write!(formatter, "WebP frame count overflow"),
            Self::DurationOverflow => write!(formatter, "WebP timeline duration overflow"),
        }
    }
}

impl Error for WebpContainerError {}

/// Errors from the 30-byte path probe used to select static versus animated
/// FFmpeg input handling before a full inspection is needed.
#[derive(Debug)]
pub enum WebpAnimationProbeError {
    Io(io::Error),
    Container(WebpContainerError),
}

impl fmt::Display for WebpAnimationProbeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "failed to read WebP header: {error}"),
            Self::Container(error) => error.fmt(formatter),
        }
    }
}

impl Error for WebpAnimationProbeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Container(error) => Some(error),
        }
    }
}

impl From<io::Error> for WebpAnimationProbeError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<WebpContainerError> for WebpAnimationProbeError {
    fn from(error: WebpContainerError) -> Self {
        Self::Container(error)
    }
}

#[derive(Clone, Copy)]
struct Chunk<'a> {
    tag: [u8; 4],
    payload: &'a [u8],
    offset: usize,
    payload_offset: usize,
}

#[derive(Clone, Copy)]
struct Vp8xInfo {
    flags: u8,
    width: u32,
    height: u32,
}

#[cfg(test)]
#[derive(Clone, Copy)]
struct ImageInfo {
    tag: [u8; 4],
    offset: usize,
    width: u32,
    height: u32,
    has_alpha: bool,
}

#[cfg(test)]
#[derive(Default)]
struct FeatureChunks {
    iccp: bool,
    exif: bool,
    xmp: bool,
}

/// Parse a complete WebP file from memory.
///
/// Every offset calculation is checked and every chunk is constrained to the
/// RIFF-declared file boundary. Unknown chunks are skipped as required for RIFF
/// extensibility, but duplicate or contradictory structural chunks are rejected.
#[cfg(test)]
pub fn parse_webp_container(bytes: &[u8]) -> Result<WebpContainerInfo, WebpContainerError> {
    if bytes.len() < 12 {
        return Err(WebpContainerError::HeaderTooShort {
            actual: bytes.len(),
        });
    }
    if bytes[0..4] != RIFF {
        return Err(WebpContainerError::InvalidRiffSignature);
    }
    if bytes[8..12] != WEBP {
        return Err(WebpContainerError::InvalidWebpSignature);
    }

    let riff_size = read_u32(&bytes[4..8]);
    let declared_file_size =
        u64::from(riff_size)
            .checked_add(8)
            .ok_or(WebpContainerError::ChunkSizeOverflow {
                chunk: RIFF,
                offset: 4,
            })?;
    if declared_file_size != bytes.len() as u64 {
        return Err(WebpContainerError::InvalidRiffSize {
            declared_file_size,
            actual_file_size: bytes.len() as u64,
        });
    }

    let mut cursor = 12usize;
    let mut chunk_index = 0usize;
    let mut vp8x = None;
    let mut anim = None;
    let mut static_image = None;
    let mut static_alpha = false;
    let mut durations = Vec::new();
    let mut playback_durations = Vec::new();
    let mut encoded_total = 0u64;
    let mut playback_total = 0u64;
    let mut features = FeatureChunks::default();

    while let Some(chunk) = next_chunk(bytes, &mut cursor, bytes.len(), 0, "top-level")? {
        match chunk.tag {
            VP8X => {
                if vp8x.is_some() {
                    return Err(duplicate(chunk));
                }
                if chunk_index != 0 {
                    return Err(WebpContainerError::InvalidChunkOrder {
                        chunk: VP8X,
                        offset: chunk.offset,
                        reason: "VP8X must be the first WebP chunk",
                    });
                }
                vp8x = Some(parse_vp8x(chunk)?);
            }
            ANIM => {
                if anim.is_some() {
                    return Err(duplicate(chunk));
                }
                let extended = vp8x.ok_or(WebpContainerError::InvalidChunkOrder {
                    chunk: ANIM,
                    offset: chunk.offset,
                    reason: "ANIM requires a preceding VP8X chunk",
                })?;
                if extended.flags & VP8X_FLAG_ANIMATION == 0 {
                    return Err(WebpContainerError::FeatureFlagMismatch {
                        chunk: ANIM,
                        flag: "animation",
                    });
                }
                if !durations.is_empty() {
                    return Err(WebpContainerError::InvalidChunkOrder {
                        chunk: ANIM,
                        offset: chunk.offset,
                        reason: "ANIM must precede every ANMF frame",
                    });
                }
                anim = Some(parse_anim(chunk)?);
            }
            ANMF => {
                let extended = vp8x.ok_or(WebpContainerError::InvalidChunkOrder {
                    chunk: ANMF,
                    offset: chunk.offset,
                    reason: "ANMF requires a preceding VP8X chunk",
                })?;
                if extended.flags & VP8X_FLAG_ANIMATION == 0 {
                    return Err(WebpContainerError::FeatureFlagMismatch {
                        chunk: ANMF,
                        flag: "animation",
                    });
                }
                if anim.is_none() {
                    return Err(WebpContainerError::InvalidChunkOrder {
                        chunk: ANMF,
                        offset: chunk.offset,
                        reason: "ANMF requires a preceding ANIM chunk",
                    });
                }
                let (encoded_duration, frame_has_alpha) =
                    parse_anmf(chunk, extended.width, extended.height)?;
                if frame_has_alpha && extended.flags & VP8X_FLAG_ALPHA == 0 {
                    return Err(WebpContainerError::FeatureFlagMismatch {
                        chunk: ANMF,
                        flag: "alpha",
                    });
                }
                let playback_duration = gifp_playback_duration(encoded_duration);
                encoded_total = encoded_total
                    .checked_add(u64::from(encoded_duration))
                    .ok_or(WebpContainerError::DurationOverflow)?;
                playback_total = playback_total
                    .checked_add(u64::from(playback_duration))
                    .ok_or(WebpContainerError::DurationOverflow)?;
                durations.push(encoded_duration);
                playback_durations.push(playback_duration);
            }
            ALPH => {
                if static_alpha {
                    return Err(duplicate(chunk));
                }
                if static_image.is_some() {
                    return Err(WebpContainerError::InvalidChunkOrder {
                        chunk: ALPH,
                        offset: chunk.offset,
                        reason: "ALPH must precede its VP8 image chunk",
                    });
                }
                validate_alpha_chunk(chunk)?;
                static_alpha = true;
            }
            VP8 | VP8L => {
                if static_image.is_some() {
                    return Err(duplicate(chunk));
                }
                let image = parse_image(chunk)?;
                if image.tag == VP8L && static_alpha {
                    return Err(WebpContainerError::InvalidChunkOrder {
                        chunk: ALPH,
                        offset: chunk.offset,
                        reason: "ALPH is only valid with a lossy VP8 image",
                    });
                }
                static_image = Some(ImageInfo {
                    has_alpha: image.has_alpha || static_alpha,
                    ..image
                });
            }
            ICCP => mark_feature(&mut features.iccp, chunk)?,
            EXIF => mark_feature(&mut features.exif, chunk)?,
            XMP => mark_feature(&mut features.xmp, chunk)?,
            _ => {}
        }
        chunk_index = chunk_index
            .checked_add(1)
            .ok_or(WebpContainerError::CountOverflow)?;
    }

    if chunk_index == 0 {
        return Err(WebpContainerError::MissingChunk {
            chunk: VP8,
            reason: "the RIFF contains no WebP chunks",
        });
    }

    match vp8x {
        Some(extended) => finish_extended(
            extended,
            anim,
            static_image,
            static_alpha,
            durations,
            playback_durations,
            encoded_total,
            playback_total,
            features,
        ),
        None => finish_simple(static_image, static_alpha, anim, durations),
    }
}

/// Determine whether a path is an animated WebP by reading at most 30 bytes.
///
/// A conforming animated WebP must begin with a 10-byte VP8X chunk whose
/// animation feature bit is set. This probe is intended only to choose the
/// correct FFmpeg demuxer options cheaply; callers should still use
/// [`inspect_webp_animation_path`] when exact animation frames and timing are
/// required.
pub fn probe_webp_animation_path(path: impl AsRef<Path>) -> Result<bool, WebpAnimationProbeError> {
    let mut file = File::open(path.as_ref())?;
    let file_size = file.metadata()?.len();
    let mut prefix = Vec::with_capacity(30);
    file.by_ref().take(30).read_to_end(&mut prefix)?;
    Ok(probe_webp_animation_prefix(&prefix, file_size)?)
}

/// Prefix form of [`probe_webp_animation_path`]. `prefix` must contain up to
/// the first 30 bytes of the file and `file_size` must be the full byte length.
pub fn probe_webp_animation_prefix(
    prefix: &[u8],
    file_size: u64,
) -> Result<bool, WebpContainerError> {
    if prefix.len() < 12 {
        return Err(WebpContainerError::HeaderTooShort {
            actual: prefix.len(),
        });
    }
    if prefix[0..4] != RIFF {
        return Err(WebpContainerError::InvalidRiffSignature);
    }
    if prefix[8..12] != WEBP {
        return Err(WebpContainerError::InvalidWebpSignature);
    }
    let declared_file_size = u64::from(read_u32(&prefix[4..8])).checked_add(8).ok_or(
        WebpContainerError::ChunkSizeOverflow {
            chunk: RIFF,
            offset: 4,
        },
    )?;
    if declared_file_size != file_size {
        return Err(WebpContainerError::InvalidRiffSize {
            declared_file_size,
            actual_file_size: file_size,
        });
    }
    if prefix.len() < 20 {
        return Err(WebpContainerError::TruncatedChunkHeader {
            context: "top-level",
            offset: 12,
            available: prefix.len() - 12,
        });
    }
    let tag: [u8; 4] = prefix[12..16].try_into().expect("bounded first chunk tag");
    if tag != VP8X {
        if matches!(tag, ANIM | ANMF | ALPH) {
            return Err(WebpContainerError::InvalidChunkOrder {
                chunk: tag,
                offset: 12,
                reason: "extended feature chunks require VP8X first",
            });
        }
        return Ok(false);
    }
    let size = read_u32(&prefix[16..20]);
    if size != 10 {
        return Err(WebpContainerError::InvalidChunkSize {
            chunk: VP8X,
            offset: 12,
            expected: 10,
            actual: usize::try_from(size).unwrap_or(usize::MAX),
        });
    }
    if prefix.len() < 30 {
        return Err(WebpContainerError::TruncatedChunkPayload {
            context: "top-level",
            chunk: VP8X,
            offset: 12,
            declared_size: 10,
            available: prefix.len().saturating_sub(20),
        });
    }
    let vp8x = parse_vp8x(Chunk {
        tag: VP8X,
        payload: &prefix[20..30],
        offset: 12,
        payload_offset: 20,
    })?;
    Ok(vp8x.flags & VP8X_FLAG_ANIMATION != 0)
}

/// Inspect an Animated WebP timeline without loading image payloads into RAM.
///
/// Static WebP files return `Ok(None)` so callers can keep using their normal
/// still-image probe. Invalid or truncated RIFF structures return an error.
pub fn inspect_webp_animation_path(
    path: impl AsRef<Path>,
) -> Result<Option<WebpAnimationSummary>, WebpAnimationProbeError> {
    let mut file = File::open(path.as_ref())?;
    let file_size = file.metadata()?.len();
    let mut riff_header = [0_u8; 12];
    file.read_exact(&mut riff_header)?;
    if riff_header[0..4] != RIFF {
        return Err(WebpContainerError::InvalidRiffSignature.into());
    }
    if riff_header[8..12] != WEBP {
        return Err(WebpContainerError::InvalidWebpSignature.into());
    }
    let declared_file_size = u64::from(read_u32(&riff_header[4..8]))
        .checked_add(8)
        .ok_or(WebpContainerError::ChunkSizeOverflow {
            chunk: RIFF,
            offset: 4,
        })?;
    if declared_file_size != file_size {
        return Err(WebpContainerError::InvalidRiffSize {
            declared_file_size,
            actual_file_size: file_size,
        }
        .into());
    }

    let mut cursor = 12_u64;
    let mut chunk_index = 0_u64;
    let mut vp8x = None;
    let mut anim = None;
    let mut frame_count = 0_u64;
    let mut encoded_total = 0_u64;
    let mut playback_total = 0_u64;

    while cursor < file_size {
        let available = file_size - cursor;
        let offset = offset_usize(cursor);
        if available < 8 {
            return Err(WebpContainerError::TruncatedChunkHeader {
                context: "top-level",
                offset,
                available: usize::try_from(available).unwrap_or(usize::MAX),
            }
            .into());
        }

        file.seek(SeekFrom::Start(cursor))?;
        let mut header = [0_u8; 8];
        file.read_exact(&mut header)?;
        let tag: [u8; 4] = header[0..4].try_into().expect("bounded chunk tag");
        let declared_size = read_u32(&header[4..8]);
        if declared_size == u32::MAX {
            return Err(WebpContainerError::ChunkSizeOverflow { chunk: tag, offset }.into());
        }
        let payload_start = cursor
            .checked_add(8)
            .ok_or(WebpContainerError::ChunkSizeOverflow { chunk: tag, offset })?;
        let payload_end = payload_start
            .checked_add(u64::from(declared_size))
            .ok_or(WebpContainerError::ChunkSizeOverflow { chunk: tag, offset })?;
        let padded_end = payload_end
            .checked_add(u64::from(declared_size & 1))
            .ok_or(WebpContainerError::ChunkSizeOverflow { chunk: tag, offset })?;
        if padded_end > file_size {
            return Err(WebpContainerError::TruncatedChunkPayload {
                context: "top-level",
                chunk: tag,
                offset,
                declared_size,
                available: usize::try_from(file_size.saturating_sub(payload_start))
                    .unwrap_or(usize::MAX),
            }
            .into());
        }

        match tag {
            VP8X => {
                if vp8x.is_some() {
                    return Err(WebpContainerError::DuplicateChunk { chunk: tag, offset }.into());
                }
                if chunk_index != 0 {
                    return Err(WebpContainerError::InvalidChunkOrder {
                        chunk: tag,
                        offset,
                        reason: "VP8X must be the first WebP chunk",
                    }
                    .into());
                }
                if declared_size != 10 {
                    return Err(WebpContainerError::InvalidChunkSize {
                        chunk: tag,
                        offset,
                        expected: 10,
                        actual: usize::try_from(declared_size).unwrap_or(usize::MAX),
                    }
                    .into());
                }
                let mut payload = [0_u8; 10];
                file.read_exact(&mut payload)?;
                vp8x = Some(parse_vp8x(Chunk {
                    tag,
                    payload: &payload,
                    offset,
                    payload_offset: offset_usize(payload_start),
                })?);
            }
            ANIM => {
                if anim.is_some() {
                    return Err(WebpContainerError::DuplicateChunk { chunk: tag, offset }.into());
                }
                let extended = vp8x.ok_or(WebpContainerError::InvalidChunkOrder {
                    chunk: tag,
                    offset,
                    reason: "ANIM requires a preceding VP8X chunk",
                })?;
                if extended.flags & VP8X_FLAG_ANIMATION == 0 {
                    return Err(WebpContainerError::FeatureFlagMismatch {
                        chunk: tag,
                        flag: "animation",
                    }
                    .into());
                }
                if frame_count != 0 {
                    return Err(WebpContainerError::InvalidChunkOrder {
                        chunk: tag,
                        offset,
                        reason: "ANIM must precede every ANMF frame",
                    }
                    .into());
                }
                if declared_size != 6 {
                    return Err(WebpContainerError::InvalidChunkSize {
                        chunk: tag,
                        offset,
                        expected: 6,
                        actual: usize::try_from(declared_size).unwrap_or(usize::MAX),
                    }
                    .into());
                }
                let mut payload = [0_u8; 6];
                file.read_exact(&mut payload)?;
                anim = Some(parse_anim(Chunk {
                    tag,
                    payload: &payload,
                    offset,
                    payload_offset: offset_usize(payload_start),
                })?);
            }
            ANMF => {
                let extended = vp8x.ok_or(WebpContainerError::InvalidChunkOrder {
                    chunk: tag,
                    offset,
                    reason: "ANMF requires a preceding VP8X chunk",
                })?;
                if extended.flags & VP8X_FLAG_ANIMATION == 0 {
                    return Err(WebpContainerError::FeatureFlagMismatch {
                        chunk: tag,
                        flag: "animation",
                    }
                    .into());
                }
                if anim.is_none() {
                    return Err(WebpContainerError::InvalidChunkOrder {
                        chunk: tag,
                        offset,
                        reason: "ANMF requires a preceding ANIM chunk",
                    }
                    .into());
                }
                if declared_size < 16 {
                    return Err(WebpContainerError::InvalidChunkSize {
                        chunk: tag,
                        offset,
                        expected: 16,
                        actual: usize::try_from(declared_size).unwrap_or(usize::MAX),
                    }
                    .into());
                }
                let mut payload = [0_u8; 16];
                file.read_exact(&mut payload)?;
                let duration = parse_anmf_header(
                    &payload,
                    offset,
                    offset_usize(payload_start),
                    extended.width,
                    extended.height,
                )?;
                frame_count = frame_count
                    .checked_add(1)
                    .ok_or(WebpContainerError::CountOverflow)?;
                encoded_total = encoded_total
                    .checked_add(u64::from(duration))
                    .ok_or(WebpContainerError::DurationOverflow)?;
                playback_total = playback_total
                    .checked_add(u64::from(gifp_playback_duration(duration)))
                    .ok_or(WebpContainerError::DurationOverflow)?;
            }
            ALPH | VP8 | VP8L
                if vp8x.is_some_and(|value| value.flags & VP8X_FLAG_ANIMATION != 0) =>
            {
                return Err(WebpContainerError::InvalidChunkOrder {
                    chunk: tag,
                    offset,
                    reason: "animated WebP stores image bitstreams inside ANMF chunks",
                }
                .into());
            }
            _ => {}
        }

        if declared_size & 1 != 0 {
            file.seek(SeekFrom::Start(payload_end))?;
            let mut padding = [0_u8; 1];
            file.read_exact(&mut padding)?;
            if padding[0] != 0 {
                return Err(WebpContainerError::NonZeroPadding {
                    context: "top-level",
                    chunk: tag,
                    offset: offset_usize(payload_end),
                }
                .into());
            }
        }
        cursor = padded_end;
        chunk_index = chunk_index
            .checked_add(1)
            .ok_or(WebpContainerError::CountOverflow)?;
    }

    let Some(extended) = vp8x else {
        return Ok(None);
    };
    if extended.flags & VP8X_FLAG_ANIMATION == 0 {
        return Ok(None);
    }
    let (background_color, loop_count) = anim.ok_or(WebpContainerError::MissingChunk {
        chunk: ANIM,
        reason: "VP8X advertises animation",
    })?;
    if frame_count == 0 {
        return Err(WebpContainerError::MissingChunk {
            chunk: ANMF,
            reason: "an animation must contain at least one frame",
        }
        .into());
    }
    Ok(Some(WebpAnimationSummary {
        canvas_width: extended.width,
        canvas_height: extended.height,
        has_alpha: extended.flags & VP8X_FLAG_ALPHA != 0,
        frame_count,
        encoded_total_duration_ms: encoded_total,
        playback_total_duration_ms: playback_total,
        loop_count,
        background_color,
    }))
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn finish_extended(
    extended: Vp8xInfo,
    anim: Option<(WebpBackgroundColor, u16)>,
    static_image: Option<ImageInfo>,
    static_alpha: bool,
    durations: Vec<u32>,
    playback_durations: Vec<u32>,
    encoded_total: u64,
    playback_total: u64,
    features: FeatureChunks,
) -> Result<WebpContainerInfo, WebpContainerError> {
    check_feature_presence(extended.flags, VP8X_FLAG_ICC, features.iccp, ICCP, "ICC")?;
    check_feature_presence(extended.flags, VP8X_FLAG_EXIF, features.exif, EXIF, "EXIF")?;
    check_feature_presence(extended.flags, VP8X_FLAG_XMP, features.xmp, XMP, "XMP")?;

    let animated = extended.flags & VP8X_FLAG_ANIMATION != 0;
    if animated {
        if static_image.is_some() || static_alpha {
            return Err(WebpContainerError::InvalidChunkOrder {
                chunk: static_image.map_or(ALPH, |image| image.tag),
                offset: static_image.map_or(0, |image| image.offset),
                reason: "animated WebP stores image bitstreams inside ANMF chunks",
            });
        }
        let (background_color, loop_count) = anim.ok_or(WebpContainerError::MissingChunk {
            chunk: ANIM,
            reason: "VP8X advertises animation",
        })?;
        if durations.is_empty() {
            return Err(WebpContainerError::MissingChunk {
                chunk: ANMF,
                reason: "an animation must contain at least one frame",
            });
        }
        let frame_count =
            u64::try_from(durations.len()).map_err(|_| WebpContainerError::CountOverflow)?;
        Ok(WebpContainerInfo {
            canvas_width: extended.width,
            canvas_height: extended.height,
            is_animated: true,
            has_alpha: extended.flags & VP8X_FLAG_ALPHA != 0,
            frame_count,
            frame_durations_ms: durations,
            playback_frame_durations_ms: playback_durations,
            encoded_total_duration_ms: encoded_total,
            total_duration_ms: playback_total,
            loop_count: Some(loop_count),
            background_color: Some(background_color),
        })
    } else {
        if anim.is_some() || !durations.is_empty() {
            return Err(WebpContainerError::FeatureFlagMismatch {
                chunk: if anim.is_some() { ANIM } else { ANMF },
                flag: "animation",
            });
        }
        let image = static_image.ok_or(WebpContainerError::MissingChunk {
            chunk: VP8,
            reason: "a static extended WebP needs one VP8 or VP8L image",
        })?;
        ensure_dimensions(image, extended.width, extended.height)?;
        if image.has_alpha && extended.flags & VP8X_FLAG_ALPHA == 0 {
            return Err(WebpContainerError::FeatureFlagMismatch {
                chunk: image.tag,
                flag: "alpha",
            });
        }
        Ok(WebpContainerInfo {
            canvas_width: extended.width,
            canvas_height: extended.height,
            is_animated: false,
            has_alpha: extended.flags & VP8X_FLAG_ALPHA != 0,
            frame_count: 1,
            frame_durations_ms: Vec::new(),
            playback_frame_durations_ms: Vec::new(),
            encoded_total_duration_ms: 0,
            total_duration_ms: 0,
            loop_count: None,
            background_color: None,
        })
    }
}

#[cfg(test)]
fn finish_simple(
    static_image: Option<ImageInfo>,
    static_alpha: bool,
    anim: Option<(WebpBackgroundColor, u16)>,
    durations: Vec<u32>,
) -> Result<WebpContainerInfo, WebpContainerError> {
    if anim.is_some() || !durations.is_empty() {
        return Err(WebpContainerError::MissingChunk {
            chunk: VP8X,
            reason: "animation requires an extended WebP header",
        });
    }
    if static_alpha {
        return Err(WebpContainerError::MissingChunk {
            chunk: VP8X,
            reason: "a top-level ALPH chunk requires an extended WebP header",
        });
    }
    let image = static_image.ok_or(WebpContainerError::MissingChunk {
        chunk: VP8,
        reason: "a simple WebP needs one VP8 or VP8L image",
    })?;
    Ok(WebpContainerInfo {
        canvas_width: image.width,
        canvas_height: image.height,
        is_animated: false,
        has_alpha: image.has_alpha,
        frame_count: 1,
        frame_durations_ms: Vec::new(),
        playback_frame_durations_ms: Vec::new(),
        encoded_total_duration_ms: 0,
        total_duration_ms: 0,
        loop_count: None,
        background_color: None,
    })
}

#[cfg(test)]
fn next_chunk<'a>(
    bytes: &'a [u8],
    cursor: &mut usize,
    limit: usize,
    base_offset: usize,
    context: &'static str,
) -> Result<Option<Chunk<'a>>, WebpContainerError> {
    if *cursor == limit {
        return Ok(None);
    }
    let available = limit.saturating_sub(*cursor);
    if available < 8 {
        return Err(WebpContainerError::TruncatedChunkHeader {
            context,
            offset: base_offset.saturating_add(*cursor),
            available,
        });
    }
    let offset = *cursor;
    let tag: [u8; 4] = bytes[offset..offset + 4]
        .try_into()
        .expect("bounded chunk tag");
    let declared_size = read_u32(&bytes[offset + 4..offset + 8]);
    // A maximum u32 payload cannot be represented together with its mandatory
    // odd-byte RIFF pad in the 32-bit chunk-size domain. FFmpeg rejects it too.
    if declared_size == u32::MAX {
        return Err(WebpContainerError::ChunkSizeOverflow {
            chunk: tag,
            offset: base_offset.saturating_add(offset),
        });
    }
    let payload_size =
        usize::try_from(declared_size).map_err(|_| WebpContainerError::ChunkSizeOverflow {
            chunk: tag,
            offset: base_offset.saturating_add(offset),
        })?;
    let payload_offset = offset
        .checked_add(8)
        .ok_or(WebpContainerError::ChunkSizeOverflow {
            chunk: tag,
            offset: base_offset.saturating_add(offset),
        })?;
    let payload_end =
        payload_offset
            .checked_add(payload_size)
            .ok_or(WebpContainerError::ChunkSizeOverflow {
                chunk: tag,
                offset: base_offset.saturating_add(offset),
            })?;
    let padded_end =
        payload_end
            .checked_add(payload_size & 1)
            .ok_or(WebpContainerError::ChunkSizeOverflow {
                chunk: tag,
                offset: base_offset.saturating_add(offset),
            })?;
    if padded_end > limit {
        return Err(WebpContainerError::TruncatedChunkPayload {
            context,
            chunk: tag,
            offset: base_offset.saturating_add(offset),
            declared_size,
            available: limit.saturating_sub(payload_offset),
        });
    }
    if payload_size & 1 != 0 && bytes[payload_end] != 0 {
        return Err(WebpContainerError::NonZeroPadding {
            context,
            chunk: tag,
            offset: base_offset.saturating_add(payload_end),
        });
    }
    *cursor = padded_end;
    Ok(Some(Chunk {
        tag,
        payload: &bytes[payload_offset..payload_end],
        offset: base_offset.saturating_add(offset),
        payload_offset: base_offset.saturating_add(payload_offset),
    }))
}

fn parse_vp8x(chunk: Chunk<'_>) -> Result<Vp8xInfo, WebpContainerError> {
    require_size(chunk, 10)?;
    let flags = chunk.payload[0];
    if flags & VP8X_RESERVED_FLAGS != 0 {
        return Err(WebpContainerError::InvalidReservedBits {
            chunk: VP8X,
            offset: chunk.payload_offset,
            value: flags & VP8X_RESERVED_FLAGS,
        });
    }
    if chunk.payload[1..4] != [0, 0, 0] {
        return Err(WebpContainerError::InvalidReservedBits {
            chunk: VP8X,
            offset: chunk.payload_offset + 1,
            value: chunk.payload[1] | chunk.payload[2] | chunk.payload[3],
        });
    }
    Ok(Vp8xInfo {
        flags,
        width: read_u24(&chunk.payload[4..7]) + 1,
        height: read_u24(&chunk.payload[7..10]) + 1,
    })
}

fn parse_anim(chunk: Chunk<'_>) -> Result<(WebpBackgroundColor, u16), WebpContainerError> {
    require_size(chunk, 6)?;
    let color = WebpBackgroundColor {
        blue: chunk.payload[0],
        green: chunk.payload[1],
        red: chunk.payload[2],
        alpha: chunk.payload[3],
    };
    let loop_count = u16::from_le_bytes([chunk.payload[4], chunk.payload[5]]);
    Ok((color, loop_count))
}

#[cfg(test)]
fn parse_anmf(
    chunk: Chunk<'_>,
    canvas_width: u32,
    canvas_height: u32,
) -> Result<(u32, bool), WebpContainerError> {
    if chunk.payload.len() < 16 {
        return Err(WebpContainerError::InvalidChunkSize {
            chunk: ANMF,
            offset: chunk.offset,
            expected: 16,
            actual: chunk.payload.len(),
        });
    }
    let header: &[u8; 16] = chunk.payload[..16].try_into().expect("bounded ANMF header");
    let duration = parse_anmf_header(
        header,
        chunk.offset,
        chunk.payload_offset,
        canvas_width,
        canvas_height,
    )?;
    let width = read_u24(&chunk.payload[6..9]) + 1;
    let height = read_u24(&chunk.payload[9..12]) + 1;
    let has_alpha = parse_frame_image_chunks(
        &chunk.payload[16..],
        chunk.payload_offset + 16,
        width,
        height,
    )?;
    Ok((duration, has_alpha))
}

fn parse_anmf_header(
    payload: &[u8; 16],
    chunk_offset: usize,
    payload_offset: usize,
    canvas_width: u32,
    canvas_height: u32,
) -> Result<u32, WebpContainerError> {
    let x =
        read_u24(&payload[0..3])
            .checked_mul(2)
            .ok_or(WebpContainerError::FrameOutOfBounds {
                offset: chunk_offset,
                x: u32::MAX,
                y: 0,
                width: 0,
                height: 0,
                canvas_width,
                canvas_height,
            })?;
    let y =
        read_u24(&payload[3..6])
            .checked_mul(2)
            .ok_or(WebpContainerError::FrameOutOfBounds {
                offset: chunk_offset,
                x,
                y: u32::MAX,
                width: 0,
                height: 0,
                canvas_width,
                canvas_height,
            })?;
    let width = read_u24(&payload[6..9]) + 1;
    let height = read_u24(&payload[9..12]) + 1;
    let duration = read_u24(&payload[12..15]);
    let flags = payload[15];
    if flags & 0xfc != 0 {
        return Err(WebpContainerError::InvalidReservedBits {
            chunk: ANMF,
            offset: payload_offset + 15,
            value: flags & 0xfc,
        });
    }
    let right = x.checked_add(width);
    let bottom = y.checked_add(height);
    if right.is_none_or(|right| right > canvas_width)
        || bottom.is_none_or(|bottom| bottom > canvas_height)
    {
        return Err(WebpContainerError::FrameOutOfBounds {
            offset: chunk_offset,
            x,
            y,
            width,
            height,
            canvas_width,
            canvas_height,
        });
    }
    Ok(duration)
}

#[cfg(test)]
fn parse_frame_image_chunks(
    bytes: &[u8],
    base_offset: usize,
    expected_width: u32,
    expected_height: u32,
) -> Result<bool, WebpContainerError> {
    let mut cursor = 0usize;
    let mut alpha = false;
    let mut image = None;
    while let Some(chunk) = next_chunk(bytes, &mut cursor, bytes.len(), base_offset, "ANMF frame")?
    {
        match chunk.tag {
            ALPH => {
                if alpha {
                    return Err(duplicate(chunk));
                }
                if image.is_some() {
                    return Err(WebpContainerError::InvalidChunkOrder {
                        chunk: ALPH,
                        offset: chunk.offset,
                        reason: "frame ALPH must precede its VP8 image",
                    });
                }
                validate_alpha_chunk(chunk)?;
                alpha = true;
            }
            VP8 | VP8L => {
                if image.is_some() {
                    return Err(duplicate(chunk));
                }
                let parsed = parse_image(chunk)?;
                if parsed.tag == VP8L && alpha {
                    return Err(WebpContainerError::InvalidChunkOrder {
                        chunk: ALPH,
                        offset: chunk.offset,
                        reason: "ALPH is only valid with a lossy VP8 frame",
                    });
                }
                ensure_dimensions(parsed, expected_width, expected_height)?;
                image = Some(parsed);
            }
            VP8X | ANIM | ANMF => {
                return Err(WebpContainerError::InvalidChunkOrder {
                    chunk: chunk.tag,
                    offset: chunk.offset,
                    reason: "container chunks cannot be nested in ANMF frame data",
                });
            }
            _ => {}
        }
    }
    let image = image.ok_or(WebpContainerError::MissingChunk {
        chunk: VP8,
        reason: "ANMF frame data needs one VP8 or VP8L image",
    })?;
    Ok(alpha || image.has_alpha)
}

#[cfg(test)]
fn parse_image(chunk: Chunk<'_>) -> Result<ImageInfo, WebpContainerError> {
    match chunk.tag {
        VP8 => parse_vp8(chunk),
        VP8L => parse_vp8l(chunk),
        _ => unreachable!("parse_image called with a non-image chunk"),
    }
}

#[cfg(test)]
fn parse_vp8(chunk: Chunk<'_>) -> Result<ImageInfo, WebpContainerError> {
    if chunk.payload.len() < 10 {
        return Err(WebpContainerError::InvalidBitstreamHeader {
            chunk: VP8,
            offset: chunk.payload_offset,
            reason: "lossy key-frame header needs at least 10 bytes",
        });
    }
    if chunk.payload[0] & 1 != 0 {
        return Err(WebpContainerError::InvalidBitstreamHeader {
            chunk: VP8,
            offset: chunk.payload_offset,
            reason: "WebP lossy image must begin with a VP8 key frame",
        });
    }
    if chunk.payload[3..6] != [0x9d, 0x01, 0x2a] {
        return Err(WebpContainerError::InvalidBitstreamHeader {
            chunk: VP8,
            offset: chunk.payload_offset + 3,
            reason: "VP8 key-frame start code is missing",
        });
    }
    let width = u32::from(u16::from_le_bytes([chunk.payload[6], chunk.payload[7]]) & 0x3fff);
    let height = u32::from(u16::from_le_bytes([chunk.payload[8], chunk.payload[9]]) & 0x3fff);
    if width == 0 || height == 0 {
        return Err(WebpContainerError::InvalidBitstreamHeader {
            chunk: VP8,
            offset: chunk.payload_offset + 6,
            reason: "VP8 dimensions must be non-zero",
        });
    }
    Ok(ImageInfo {
        tag: VP8,
        offset: chunk.offset,
        width,
        height,
        has_alpha: false,
    })
}

#[cfg(test)]
fn parse_vp8l(chunk: Chunk<'_>) -> Result<ImageInfo, WebpContainerError> {
    if chunk.payload.len() < 5 || chunk.payload[0] != 0x2f {
        return Err(WebpContainerError::InvalidBitstreamHeader {
            chunk: VP8L,
            offset: chunk.payload_offset,
            reason: "lossless signature/header is missing",
        });
    }
    let bits = read_u32(&chunk.payload[1..5]);
    if bits >> 29 != 0 {
        return Err(WebpContainerError::InvalidBitstreamHeader {
            chunk: VP8L,
            offset: chunk.payload_offset + 1,
            reason: "VP8L version bits must be zero",
        });
    }
    Ok(ImageInfo {
        tag: VP8L,
        offset: chunk.offset,
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
        has_alpha: bits & (1 << 28) != 0,
    })
}

#[cfg(test)]
fn validate_alpha_chunk(chunk: Chunk<'_>) -> Result<(), WebpContainerError> {
    let Some(header) = chunk.payload.first().copied() else {
        return Err(WebpContainerError::InvalidChunkSize {
            chunk: ALPH,
            offset: chunk.offset,
            expected: 1,
            actual: 0,
        });
    };
    if header & 0xc0 != 0 {
        return Err(WebpContainerError::InvalidReservedBits {
            chunk: ALPH,
            offset: chunk.payload_offset,
            value: header & 0xc0,
        });
    }
    Ok(())
}

#[cfg(test)]
fn ensure_dimensions(image: ImageInfo, width: u32, height: u32) -> Result<(), WebpContainerError> {
    if image.width != width || image.height != height {
        return Err(WebpContainerError::DimensionMismatch {
            chunk: image.tag,
            offset: image.offset,
            expected_width: width,
            expected_height: height,
            actual_width: image.width,
            actual_height: image.height,
        });
    }
    Ok(())
}

fn require_size(chunk: Chunk<'_>, expected: usize) -> Result<(), WebpContainerError> {
    if chunk.payload.len() != expected {
        return Err(WebpContainerError::InvalidChunkSize {
            chunk: chunk.tag,
            offset: chunk.offset,
            expected,
            actual: chunk.payload.len(),
        });
    }
    Ok(())
}

#[cfg(test)]
fn mark_feature(seen: &mut bool, chunk: Chunk<'_>) -> Result<(), WebpContainerError> {
    if *seen {
        return Err(duplicate(chunk));
    }
    *seen = true;
    Ok(())
}

#[cfg(test)]
fn check_feature_presence(
    flags: u8,
    flag: u8,
    present: bool,
    chunk: [u8; 4],
    label: &'static str,
) -> Result<(), WebpContainerError> {
    if (flags & flag != 0) != present {
        return Err(WebpContainerError::FeatureFlagMismatch { chunk, flag: label });
    }
    Ok(())
}

#[cfg(test)]
fn duplicate(chunk: Chunk<'_>) -> WebpContainerError {
    WebpContainerError::DuplicateChunk {
        chunk: chunk.tag,
        offset: chunk.offset,
    }
}

fn playback_duration_with_min_delay(encoded_duration_ms: u32, min_delay_ms: u32) -> u32 {
    if encoded_duration_ms <= min_delay_ms {
        FFMPEG_9_DEFAULT_FRAME_DURATION_MS
    } else {
        encoded_duration_ms
    }
}

fn gifp_playback_duration(encoded_duration_ms: u32) -> u32 {
    playback_duration_with_min_delay(encoded_duration_ms, GIFP_WEBP_MIN_FRAME_DURATION_MS)
}

fn offset_usize(offset: u64) -> usize {
    usize::try_from(offset).unwrap_or(usize::MAX)
}

fn read_u24(bytes: &[u8]) -> u32 {
    u32::from(bytes[0]) | (u32::from(bytes[1]) << 8) | (u32::from(bytes[2]) << 16)
}

fn read_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes[..4].try_into().expect("bounded little-endian u32"))
}

fn fourcc(tag: [u8; 4]) -> String {
    String::from_utf8_lossy(&tag).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn u24(value: u32) -> [u8; 3] {
        [value as u8, (value >> 8) as u8, (value >> 16) as u8]
    }

    fn chunk(tag: [u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(8 + payload.len() + (payload.len() & 1));
        bytes.extend_from_slice(&tag);
        bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(payload);
        if payload.len() & 1 != 0 {
            bytes.push(0);
        }
        bytes
    }

    fn riff(chunks: &[Vec<u8>]) -> Vec<u8> {
        let mut bytes = b"RIFF\0\0\0\0WEBP".to_vec();
        for item in chunks {
            bytes.extend_from_slice(item);
        }
        let riff_size = u32::try_from(bytes.len() - 8).unwrap();
        bytes[4..8].copy_from_slice(&riff_size.to_le_bytes());
        bytes
    }

    fn vp8x(flags: u8, width: u32, height: u32) -> Vec<u8> {
        let mut payload = vec![flags, 0, 0, 0];
        payload.extend_from_slice(&u24(width - 1));
        payload.extend_from_slice(&u24(height - 1));
        chunk(VP8X, &payload)
    }

    fn vp8(width: u16, height: u16) -> Vec<u8> {
        let mut payload = vec![0, 0, 0, 0x9d, 0x01, 0x2a];
        payload.extend_from_slice(&width.to_le_bytes());
        payload.extend_from_slice(&height.to_le_bytes());
        chunk(VP8, &payload)
    }

    fn vp8l(width: u32, height: u32, alpha: bool) -> Vec<u8> {
        let bits = (width - 1) | ((height - 1) << 14) | if alpha { 1 << 28 } else { 0 };
        let mut payload = vec![0x2f];
        payload.extend_from_slice(&bits.to_le_bytes());
        chunk(VP8L, &payload)
    }

    fn anim(color_bgra: [u8; 4], loop_count: u16) -> Vec<u8> {
        let mut payload = color_bgra.to_vec();
        payload.extend_from_slice(&loop_count.to_le_bytes());
        chunk(ANIM, &payload)
    }

    fn anmf(x: u32, y: u32, width: u32, height: u32, duration: u32, image: Vec<u8>) -> Vec<u8> {
        assert_eq!(x & 1, 0);
        assert_eq!(y & 1, 0);
        let mut payload = Vec::new();
        payload.extend_from_slice(&u24(x / 2));
        payload.extend_from_slice(&u24(y / 2));
        payload.extend_from_slice(&u24(width - 1));
        payload.extend_from_slice(&u24(height - 1));
        payload.extend_from_slice(&u24(duration));
        payload.push(0);
        payload.extend_from_slice(&image);
        chunk(ANMF, &payload)
    }

    #[test]
    fn parses_simple_static_lossless_webp() {
        let bytes = riff(&[vp8l(320, 200, true)]);
        let parsed = parse_webp_container(&bytes).unwrap();

        assert_eq!(parsed.canvas_width, 320);
        assert_eq!(parsed.canvas_height, 200);
        assert!(!parsed.is_animated);
        assert!(parsed.has_alpha);
        assert_eq!(parsed.frame_count, 1);
        assert!(parsed.frame_durations_ms.is_empty());
        assert_eq!(parsed.total_duration_ms, 0);
        assert_eq!(parsed.loop_count, None);
        assert_eq!(parsed.background_color, None);
    }

    #[test]
    fn parses_extended_static_webp_with_alpha() {
        let bytes = riff(&[
            vp8x(VP8X_FLAG_ALPHA, 64, 32),
            chunk(ALPH, &[0]),
            vp8(64, 32),
        ]);
        let parsed = parse_webp_container(&bytes).unwrap();

        assert_eq!((parsed.canvas_width, parsed.canvas_height), (64, 32));
        assert!(parsed.has_alpha);
        assert!(!parsed.is_animated);
    }

    #[test]
    fn parses_animation_timing_loop_background_and_frames() {
        let bytes = riff(&[
            vp8x(VP8X_FLAG_ANIMATION | VP8X_FLAG_ALPHA, 8, 4),
            anim([0x33, 0x22, 0x11, 0x44], 3),
            anmf(0, 0, 8, 4, 25, vp8l(8, 4, true)),
            anmf(2, 0, 6, 4, 40, vp8l(6, 4, false)),
        ]);
        let parsed = parse_webp_container(&bytes).unwrap();

        assert_eq!((parsed.canvas_width, parsed.canvas_height), (8, 4));
        assert!(parsed.is_animated);
        assert!(parsed.has_alpha);
        assert_eq!(parsed.frame_count, 2);
        assert_eq!(parsed.frame_durations_ms, [25, 40]);
        assert_eq!(parsed.playback_frame_durations_ms, [25, 40]);
        assert_eq!(parsed.encoded_total_duration_ms, 65);
        assert_eq!(parsed.total_duration_ms, 65);
        assert_eq!(parsed.loop_count, Some(3));
        assert_eq!(
            parsed.background_color,
            Some(WebpBackgroundColor {
                red: 0x11,
                green: 0x22,
                blue: 0x33,
                alpha: 0x44,
            })
        );
    }

    #[test]
    fn skips_odd_chunks_and_requires_zero_padding() {
        let bytes = riff(&[
            vp8x(0, 2, 2),
            chunk(*b"JUNK", &[1, 2, 3]),
            vp8l(2, 2, false),
        ]);
        assert_eq!(parse_webp_container(&bytes).unwrap().frame_count, 1);

        let mut invalid = bytes;
        let junk_pad = 12 + vp8x(0, 2, 2).len() + 8 + 3;
        invalid[junk_pad] = 0xff;
        assert!(matches!(
            parse_webp_container(&invalid),
            Err(WebpContainerError::NonZeroPadding { chunk, .. }) if chunk == *b"JUNK"
        ));
    }

    #[test]
    fn rejects_truncated_chunk_within_exact_riff_boundary() {
        let mut body = Vec::new();
        body.extend_from_slice(&VP8X);
        body.extend_from_slice(&10u32.to_le_bytes());
        body.extend_from_slice(&[0; 5]);
        let bytes = riff(&[body]);

        assert!(matches!(
            parse_webp_container(&bytes),
            Err(WebpContainerError::TruncatedChunkPayload { chunk, .. }) if chunk == VP8X
        ));
    }

    #[test]
    fn rejects_chunk_size_that_overflows_riff_padding() {
        let mut body = Vec::new();
        body.extend_from_slice(&VP8X);
        body.extend_from_slice(&u32::MAX.to_le_bytes());
        let bytes = riff(&[body]);

        assert!(matches!(
            parse_webp_container(&bytes),
            Err(WebpContainerError::ChunkSizeOverflow { chunk, .. }) if chunk == VP8X
        ));
    }

    #[test]
    fn preserves_positive_short_durations_with_gifp_ffmpeg_9_policy() {
        let bytes = riff(&[
            vp8x(VP8X_FLAG_ANIMATION, 1, 1),
            anim([0, 0, 0, 0], 0),
            anmf(0, 0, 1, 1, 0, vp8l(1, 1, false)),
            anmf(0, 0, 1, 1, 10, vp8l(1, 1, false)),
            anmf(0, 0, 1, 1, 11, vp8l(1, 1, false)),
        ]);
        let parsed = parse_webp_container(&bytes).unwrap();

        // FFmpeg 9's comparison is inclusive (`duration <= min_delay`). GIFP
        // sets min_delay=0, so only the zero-duration frame is normalized.
        assert_eq!(parsed.frame_count, 3);
        assert_eq!(parsed.frame_durations_ms, [0, 10, 11]);
        assert_eq!(parsed.playback_frame_durations_ms, [100, 10, 11]);
        assert_eq!(parsed.encoded_total_duration_ms, 21);
        assert_eq!(parsed.total_duration_ms, 121);
        assert_eq!(
            playback_duration_with_min_delay(10, FFMPEG_9_DEFAULT_MIN_FRAME_DURATION_MS),
            100
        );
    }

    #[test]
    fn streams_animation_timeline_without_decoding_payloads() {
        let bytes = riff(&[
            vp8x(VP8X_FLAG_ANIMATION | VP8X_FLAG_ALPHA, 8, 4),
            anim([0x33, 0x22, 0x11, 0x44], 3),
            anmf(0, 0, 8, 4, 0, vp8l(8, 4, true)),
            anmf(2, 0, 6, 4, 10, vp8l(6, 4, false)),
            anmf(2, 0, 6, 4, 11, vp8l(6, 4, false)),
        ]);
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "gifp-webp-stream-{}-{unique}.webp",
            std::process::id()
        ));
        let mut file = File::create(&path).unwrap();
        file.write_all(&bytes).unwrap();
        drop(file);

        let summary = inspect_webp_animation_path(&path)
            .unwrap()
            .expect("animated summary");
        assert_eq!((summary.canvas_width, summary.canvas_height), (8, 4));
        assert!(summary.has_alpha);
        assert_eq!(summary.frame_count, 3);
        assert_eq!(summary.encoded_total_duration_ms, 21);
        assert_eq!(summary.playback_total_duration_ms, 121);
        assert_eq!(summary.loop_count, 3);
        assert_eq!(
            summary.background_color,
            WebpBackgroundColor {
                red: 0x11,
                green: 0x22,
                blue: 0x33,
                alpha: 0x44,
            }
        );

        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn rejects_duplicate_structural_chunks() {
        let bytes = riff(&[vp8x(0, 1, 1), vp8x(0, 1, 1), vp8l(1, 1, false)]);
        assert!(matches!(
            parse_webp_container(&bytes),
            Err(WebpContainerError::DuplicateChunk { chunk, .. }) if chunk == VP8X
        ));

        let bytes = riff(&[
            vp8x(VP8X_FLAG_ANIMATION, 1, 1),
            anim([0; 4], 0),
            anim([0; 4], 0),
            anmf(0, 0, 1, 1, 20, vp8l(1, 1, false)),
        ]);
        assert!(matches!(
            parse_webp_container(&bytes),
            Err(WebpContainerError::DuplicateChunk { chunk, .. }) if chunk == ANIM
        ));
    }

    #[test]
    fn rejects_frame_rectangle_outside_canvas() {
        let bytes = riff(&[
            vp8x(VP8X_FLAG_ANIMATION, 4, 4),
            anim([0; 4], 1),
            anmf(2, 0, 4, 4, 20, vp8l(4, 4, false)),
        ]);
        assert!(matches!(
            parse_webp_container(&bytes),
            Err(WebpContainerError::FrameOutOfBounds { .. })
        ));
    }
}
