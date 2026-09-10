//! Minimal, dependency-free Apple Live Photo pair authoring for GIFP.
//!
//! This module deliberately accepts only the controlled MOV layout emitted by
//! GIFP's FFmpeg lane: a sub-4-GiB, non-fragmented file with one video track,
//! media data before a final `moov` atom, and an existing movie-level content
//! identifier. Keeping the contract narrow lets the post-processor preserve all
//! encoded media bytes and all pre-existing chunk offsets.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs, path::Path};
use thiserror::Error;

pub const LIVE_PHOTO_REPORT_SCHEMA_VERSION: u16 = 1;

const CONTENT_IDENTIFIER_KEY: &str = "com.apple.quicktime.content.identifier";
const STILL_IMAGE_TIME_KEY: &str = "com.apple.quicktime.still-image-time";
const CONTRACT_DOMAIN: &[u8] = b"gifp.live-photo.contract.v1\0";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct LivePhotoReport {
    pub schema_version: u16,
    pub pair_verified: bool,
    pub asset_identifier: String,
    pub still_time_movie_units: u64,
    pub movie_timescale: u32,
    pub video_track_id: u32,
    pub metadata_track_id: u32,
    pub metadata_sample_offset: u64,
    pub jpeg_bytes: Option<u64>,
    pub mov_bytes: u64,
    pub jpeg_sha256: Option<String>,
    pub jpeg_scan_sha256: Option<String>,
    pub mov_sha256: String,
    pub metadata_sample_sha256: String,
    pub contract_sha256: String,
}

#[derive(Clone, Debug, Eq, Error, PartialEq, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum LivePhotoError {
    #[error("asset identifier must be an uppercase hyphenated UUID, got '{value}'")]
    InvalidAssetIdentifier { value: String },
    #[error("failed to read {path}: {reason}")]
    ReadFailed { path: String, reason: String },
    #[error("failed to write {path}: {reason}")]
    WriteFailed { path: String, reason: String },
    #[error("invalid JPEG at byte {offset}: {reason}")]
    InvalidJpeg { offset: u64, reason: String },
    #[error("the JPEG already contains EXIF; P0 refuses to overwrite it")]
    ExistingExif,
    #[error("invalid EXIF/Apple MakerNote: {reason}")]
    InvalidMakerNote { reason: String },
    #[error("MOV is too large for the P0 32-bit writer: {bytes} bytes")]
    MovTooLarge { bytes: u64 },
    #[error("malformed MOV atom at byte {offset} in {context}: {reason}")]
    MalformedAtom {
        context: String,
        offset: u64,
        reason: String,
    },
    #[error("unsupported MOV layout: {reason}")]
    UnsupportedMov { reason: String },
    #[error("fragmented MOV input is not supported")]
    FragmentedMov,
    #[error("expected exactly one video track, found {found}")]
    VideoTrackCount { found: usize },
    #[error("MOV has no com.apple.quicktime.content.identifier")]
    MissingContentIdentifier,
    #[error("content identifier mismatch: expected {expected}, found {found}")]
    ContentIdentifierMismatch { expected: String, found: String },
    #[error("JPEG/MOV asset identifiers disagree: JPEG {jpeg}, MOV {mov}")]
    PairIdentifierMismatch { jpeg: String, mov: String },
    #[error("still time {still_time} is outside movie duration {duration}")]
    InvalidStillTime { still_time: u64, duration: u64 },
    #[error("a com.apple.quicktime.still-image-time track already exists")]
    ExistingStillImageTimeTrack,
    #[error("Live Photo verification failed for {field}: expected {expected}, found {actual}")]
    VerificationFailed {
        field: String,
        expected: String,
        actual: String,
    },
    #[error("integer overflow while building {context}")]
    IntegerOverflow { context: String },
}

/// Adds the Apple asset identifier MakerNote to a JPEG in place.
pub fn stamp_jpeg_asset_identifier(
    jpeg_path: &Path,
    asset_identifier: &str,
) -> Result<(), LivePhotoError> {
    validate_asset_identifier(asset_identifier)?;
    let input = read_file(jpeg_path)?;
    let output = stamp_jpeg_bytes(&input, asset_identifier)?;
    let verified = extract_jpeg_asset_identifier(&output)?;
    if verified != asset_identifier {
        return Err(LivePhotoError::VerificationFailed {
            field: "stamped JPEG asset identifier".to_string(),
            expected: asset_identifier.to_string(),
            actual: verified,
        });
    }
    fs::write(jpeg_path, output).map_err(|error| LivePhotoError::WriteFailed {
        path: jpeg_path.display().to_string(),
        reason: error.to_string(),
    })
}

/// Appends a one-sample QuickTime timed-metadata track without moving media data.
pub fn finalize_mov_live_photo(
    input_mov_path: &Path,
    output_mov_path: &Path,
    asset_identifier: &str,
    still_time_movie_units: u64,
) -> Result<LivePhotoReport, LivePhotoError> {
    validate_asset_identifier(asset_identifier)?;
    let input = read_file(input_mov_path)?;
    let output = finalize_mov_bytes(&input, asset_identifier, still_time_movie_units)?;
    let report = inspect_live_photo(None, &output, asset_identifier)?;
    fs::write(output_mov_path, &output).map_err(|error| LivePhotoError::WriteFailed {
        path: output_mov_path.display().to_string(),
        reason: error.to_string(),
    })?;
    Ok(report)
}

/// Verifies both resource halves and returns a hash-closed contract report.
pub fn verify_live_photo_pair(
    jpeg_path: &Path,
    mov_path: &Path,
    asset_identifier: &str,
) -> Result<LivePhotoReport, LivePhotoError> {
    validate_asset_identifier(asset_identifier)?;
    let jpeg = read_file(jpeg_path)?;
    let mov = read_file(mov_path)?;
    inspect_live_photo(Some(&jpeg), &mov, asset_identifier)
}

fn read_file(path: &Path) -> Result<Vec<u8>, LivePhotoError> {
    fs::read(path).map_err(|error| LivePhotoError::ReadFailed {
        path: path.display().to_string(),
        reason: error.to_string(),
    })
}

fn validate_asset_identifier(value: &str) -> Result<(), LivePhotoError> {
    let valid = value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte),
        });
    if valid {
        Ok(())
    } else {
        Err(LivePhotoError::InvalidAssetIdentifier {
            value: value.to_string(),
        })
    }
}

// The byte-level implementation follows below. Keeping these three private
// functions as the only API boundary also makes fuzzing possible without I/O.
fn stamp_jpeg_bytes(jpeg: &[u8], asset_identifier: &str) -> Result<Vec<u8>, LivePhotoError> {
    validate_asset_identifier(asset_identifier)?;
    let layout = parse_jpeg_layout(jpeg)?;
    if layout.exif_found {
        return Err(LivePhotoError::ExistingExif);
    }

    let app1 = build_exif_app1(asset_identifier)?;
    let mut output = Vec::with_capacity(jpeg.len().saturating_add(app1.len()));
    output.extend_from_slice(&jpeg[..layout.insert_at]);
    output.extend_from_slice(&app1);
    output.extend_from_slice(&jpeg[layout.insert_at..]);
    Ok(output)
}

#[derive(Clone, Copy, Debug)]
struct JpegLayout {
    insert_at: usize,
    scan_start: usize,
    exif_found: bool,
}

fn parse_jpeg_layout(jpeg: &[u8]) -> Result<JpegLayout, LivePhotoError> {
    if jpeg.len() < 4 || jpeg[..2] != [0xff, 0xd8] {
        return Err(LivePhotoError::InvalidJpeg {
            offset: 0,
            reason: "missing SOI marker".to_string(),
        });
    }

    let mut position = 2usize;
    let mut insert_at = 2usize;
    let mut exif_found = false;
    while position < jpeg.len() {
        let marker_start = position;
        if jpeg[position] != 0xff {
            return Err(LivePhotoError::InvalidJpeg {
                offset: position as u64,
                reason: "expected marker prefix before scan data".to_string(),
            });
        }
        while position < jpeg.len() && jpeg[position] == 0xff {
            position += 1;
        }
        if position >= jpeg.len() {
            return Err(LivePhotoError::InvalidJpeg {
                offset: marker_start as u64,
                reason: "truncated marker".to_string(),
            });
        }
        let marker = jpeg[position];
        position += 1;
        if marker == 0x00 {
            return Err(LivePhotoError::InvalidJpeg {
                offset: marker_start as u64,
                reason: "byte-stuffed marker occurred before SOS".to_string(),
            });
        }
        if marker == 0xd9 {
            return Err(LivePhotoError::InvalidJpeg {
                offset: marker_start as u64,
                reason: "EOI occurred before SOS".to_string(),
            });
        }
        if marker == 0xd8 {
            return Err(LivePhotoError::InvalidJpeg {
                offset: marker_start as u64,
                reason: "duplicate SOI marker".to_string(),
            });
        }
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        if position.checked_add(2).is_none_or(|end| end > jpeg.len()) {
            return Err(LivePhotoError::InvalidJpeg {
                offset: position as u64,
                reason: "truncated segment length".to_string(),
            });
        }
        let segment_length = usize::from(u16::from_be_bytes([jpeg[position], jpeg[position + 1]]));
        if segment_length < 2 {
            return Err(LivePhotoError::InvalidJpeg {
                offset: position as u64,
                reason: "segment length is smaller than its length field".to_string(),
            });
        }
        let segment_end =
            position
                .checked_add(segment_length)
                .ok_or_else(|| LivePhotoError::InvalidJpeg {
                    offset: position as u64,
                    reason: "segment length overflow".to_string(),
                })?;
        if segment_end > jpeg.len() {
            return Err(LivePhotoError::InvalidJpeg {
                offset: position as u64,
                reason: "segment extends past the file".to_string(),
            });
        }

        if marker == 0xda {
            return Ok(JpegLayout {
                insert_at,
                scan_start: marker_start,
                exif_found,
            });
        }

        let payload_start = position + 2;
        if marker == 0xe1
            && jpeg
                .get(payload_start..payload_start.saturating_add(6))
                .is_some_and(|prefix| prefix == b"Exif\0\0")
        {
            exif_found = true;
        }
        position = segment_end;
        // Preserve the conventional ordering of JFIF/JFXX APP0 records before
        // EXIF while never moving any existing bytes.
        if marker == 0xe0 && insert_at == marker_start {
            insert_at = segment_end;
        }
    }

    Err(LivePhotoError::InvalidJpeg {
        offset: jpeg.len() as u64,
        reason: "missing SOS marker".to_string(),
    })
}

fn build_exif_app1(asset_identifier: &str) -> Result<Vec<u8>, LivePhotoError> {
    let maker_note = build_apple_maker_note(asset_identifier)?;

    // Big-endian TIFF. IFD0 has Make and ExifIFDPointer. The Exif IFD has the
    // MakerNote. Every offset is relative to the outer TIFF header.
    let ifd0_offset = 8u32;
    let ifd0_end = 8usize + 2 + 2 * 12 + 4;
    let make_offset = u32::try_from(ifd0_end).map_err(|_| LivePhotoError::IntegerOverflow {
        context: "JPEG Make offset".to_string(),
    })?;
    let exif_ifd_offset = make_offset + 6;
    let maker_note_offset = exif_ifd_offset + 2 + 12 + 4;

    let mut tiff = Vec::with_capacity(maker_note_offset as usize + maker_note.len());
    tiff.extend_from_slice(b"MM");
    push_u16(&mut tiff, 42);
    push_u32(&mut tiff, ifd0_offset);
    push_u16(&mut tiff, 2);
    push_tiff_entry(&mut tiff, 0x010f, 2, 6, make_offset);
    push_tiff_entry(&mut tiff, 0x8769, 4, 1, exif_ifd_offset);
    push_u32(&mut tiff, 0);
    tiff.extend_from_slice(b"Apple\0");
    push_u16(&mut tiff, 1);
    push_tiff_entry(
        &mut tiff,
        0x927c,
        7,
        u32::try_from(maker_note.len()).map_err(|_| LivePhotoError::IntegerOverflow {
            context: "Apple MakerNote length".to_string(),
        })?,
        maker_note_offset,
    );
    push_u32(&mut tiff, 0);
    tiff.extend_from_slice(&maker_note);

    let mut payload = Vec::with_capacity(6 + tiff.len());
    payload.extend_from_slice(b"Exif\0\0");
    payload.extend_from_slice(&tiff);
    let segment_length = payload
        .len()
        .checked_add(2)
        .and_then(|length| u16::try_from(length).ok())
        .ok_or_else(|| LivePhotoError::IntegerOverflow {
            context: "JPEG APP1 length".to_string(),
        })?;
    let mut app1 = Vec::with_capacity(payload.len() + 4);
    app1.extend_from_slice(&[0xff, 0xe1]);
    push_u16(&mut app1, segment_length);
    app1.extend_from_slice(&payload);
    Ok(app1)
}

fn build_apple_maker_note(asset_identifier: &str) -> Result<Vec<u8>, LivePhotoError> {
    validate_asset_identifier(asset_identifier)?;
    let value_length = asset_identifier.len() + 1;
    // Real Apple MakerNotes use a TIFF-like IFD, not a nested TIFF header:
    //   14-byte signature `Apple iOS\0\0\x01MM`
    //   BE u16 entry count, 12-byte entries, BE u32 next-IFD offset, values.
    // Entry value offsets are relative to byte zero of the MakerNote payload.
    // This matches the signature and offset base recognized by ExifTool and by
    // independent parsers of native iPhone assets.
    const SIGNATURE: &[u8; 14] = b"Apple iOS\0\0\x01MM";
    let value_offset = SIGNATURE.len() as u32 + 2 + 12 + 4;
    let mut note = Vec::with_capacity(value_offset as usize + value_length);
    note.extend_from_slice(SIGNATURE);
    push_u16(&mut note, 1);
    push_tiff_entry(
        &mut note,
        0x0011,
        2,
        u32::try_from(value_length).map_err(|_| LivePhotoError::IntegerOverflow {
            context: "Apple asset identifier".to_string(),
        })?,
        value_offset,
    );
    push_u32(&mut note, 0);
    note.extend_from_slice(asset_identifier.as_bytes());
    note.push(0);
    Ok(note)
}

fn push_tiff_entry(output: &mut Vec<u8>, tag: u16, field_type: u16, count: u32, value: u32) {
    push_u16(output, tag);
    push_u16(output, field_type);
    push_u32(output, count);
    push_u32(output, value);
}

fn finalize_mov_bytes(
    mov: &[u8],
    asset_identifier: &str,
    still_time_movie_units: u64,
) -> Result<Vec<u8>, LivePhotoError> {
    validate_asset_identifier(asset_identifier)?;
    let layout = parse_movie_layout(mov)?;
    let movie_identifier = read_movie_content_identifier(mov, &layout.moov)?;
    if movie_identifier != asset_identifier {
        return Err(LivePhotoError::ContentIdentifierMismatch {
            expected: asset_identifier.to_string(),
            found: movie_identifier,
        });
    }
    if find_still_image_track(mov, &layout, false)?.is_some() {
        return Err(LivePhotoError::ExistingStillImageTimeTrack);
    }
    if still_time_movie_units >= layout.movie_duration
        || still_time_movie_units
            .checked_add(1)
            .is_none_or(|end| end > layout.movie_duration)
        || still_time_movie_units > u64::from(u32::MAX)
    {
        return Err(LivePhotoError::InvalidStillTime {
            still_time: still_time_movie_units,
            duration: layout.movie_duration,
        });
    }

    let metadata_track_id = choose_metadata_track_id(&layout)?;
    let sample_offset = layout
        .moov
        .start
        .checked_add(8)
        .and_then(|offset| u32::try_from(offset).ok())
        .ok_or_else(|| LivePhotoError::IntegerOverflow {
            context: "metadata sample chunk offset".to_string(),
        })?;
    let metadata_track = build_metadata_track(
        metadata_track_id,
        layout.video_track_id,
        layout.movie_timescale,
        still_time_movie_units as u32,
        sample_offset,
    )?;
    let new_moov = rebuild_moov_with_track(mov, &layout, &metadata_track, metadata_track_id)?;

    let output_size = layout
        .moov
        .start
        .checked_add(9)
        .and_then(|size| size.checked_add(new_moov.len()))
        .ok_or_else(|| LivePhotoError::IntegerOverflow {
            context: "final Live Photo MOV".to_string(),
        })?;
    if output_size >= u32::MAX as usize {
        return Err(LivePhotoError::MovTooLarge {
            bytes: output_size as u64,
        });
    }
    let mut output = Vec::with_capacity(output_size);
    output.extend_from_slice(&mov[..layout.moov.start]);
    push_u32(&mut output, 9);
    output.extend_from_slice(b"mdat");
    output.push(0xff);
    output.extend_from_slice(&new_moov);
    Ok(output)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Atom {
    kind: [u8; 4],
    start: usize,
    size: usize,
    header_size: usize,
}

impl Atom {
    fn payload_start(self) -> usize {
        self.start + self.header_size
    }

    fn end(self) -> usize {
        self.start + self.size
    }
}

#[derive(Clone, Debug)]
struct TrackInfo {
    atom: Atom,
    track_id: u32,
    handler: [u8; 4],
}

#[derive(Clone, Debug)]
struct MovieLayout {
    moov: Atom,
    moov_children: Vec<Atom>,
    mvhd: Atom,
    movie_timescale: u32,
    movie_duration: u64,
    next_track_id: u32,
    tracks: Vec<TrackInfo>,
    video_track_id: u32,
    mdat_payloads: Vec<(usize, usize)>,
}

fn parse_movie_layout(mov: &[u8]) -> Result<MovieLayout, LivePhotoError> {
    if mov.len() >= u32::MAX as usize {
        return Err(LivePhotoError::MovTooLarge {
            bytes: mov.len() as u64,
        });
    }
    let top = parse_atom_sequence(mov, 0, mov.len(), "file", true)?;
    if top.iter().any(|atom| atom.kind == *b"moof") {
        return Err(LivePhotoError::FragmentedMov);
    }
    let moov_atoms: Vec<_> = top
        .iter()
        .copied()
        .filter(|atom| atom.kind == *b"moov")
        .collect();
    if moov_atoms.len() != 1 {
        return Err(LivePhotoError::UnsupportedMov {
            reason: format!("expected one moov atom, found {}", moov_atoms.len()),
        });
    }
    let moov = moov_atoms[0];
    if top.last().copied() != Some(moov) || moov.end() != mov.len() {
        return Err(LivePhotoError::UnsupportedMov {
            reason: "moov must be the final top-level atom".to_string(),
        });
    }
    let mdat_payloads: Vec<_> = top
        .iter()
        .filter(|atom| atom.kind == *b"mdat" && atom.end() <= moov.start)
        .map(|atom| (atom.payload_start(), atom.end()))
        .collect();
    if mdat_payloads.is_empty() {
        return Err(LivePhotoError::UnsupportedMov {
            reason: "at least one mdat atom must precede moov".to_string(),
        });
    }

    let moov_children = parse_atom_sequence(mov, moov.payload_start(), moov.end(), "moov", false)?;
    if moov_children.iter().any(|atom| atom.kind == *b"mvex") {
        return Err(LivePhotoError::FragmentedMov);
    }
    let mvhd_atoms: Vec<_> = moov_children
        .iter()
        .copied()
        .filter(|atom| atom.kind == *b"mvhd")
        .collect();
    if mvhd_atoms.len() != 1 {
        return Err(LivePhotoError::UnsupportedMov {
            reason: format!("expected one mvhd atom, found {}", mvhd_atoms.len()),
        });
    }
    let mvhd = mvhd_atoms[0];
    let (movie_timescale, movie_duration, next_track_id) = parse_mvhd(mov, mvhd)?;
    if movie_timescale == 0 || movie_duration == 0 {
        return Err(LivePhotoError::UnsupportedMov {
            reason: "movie timescale and duration must be non-zero".to_string(),
        });
    }

    let mut tracks = Vec::new();
    for atom in moov_children
        .iter()
        .copied()
        .filter(|atom| atom.kind == *b"trak")
    {
        tracks.push(parse_track_info(mov, atom)?);
    }
    if tracks.is_empty() {
        return Err(LivePhotoError::UnsupportedMov {
            reason: "movie has no tracks".to_string(),
        });
    }
    let mut ids: Vec<_> = tracks.iter().map(|track| track.track_id).collect();
    ids.sort_unstable();
    if ids.first() == Some(&0) || ids.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(LivePhotoError::UnsupportedMov {
            reason: "track IDs must be unique and non-zero".to_string(),
        });
    }
    let videos: Vec<_> = tracks
        .iter()
        .filter(|track| track.handler == *b"vide")
        .collect();
    if videos.len() != 1 {
        return Err(LivePhotoError::VideoTrackCount {
            found: videos.len(),
        });
    }
    let video_track_id = videos[0].track_id;
    for track in &tracks {
        validate_track_chunk_offsets(mov, track, &mdat_payloads)?;
    }

    Ok(MovieLayout {
        moov,
        moov_children,
        mvhd,
        movie_timescale,
        movie_duration,
        next_track_id,
        tracks,
        video_track_id,
        mdat_payloads,
    })
}

fn parse_atom_sequence(
    data: &[u8],
    start: usize,
    end: usize,
    context: &str,
    allow_terminal_size_zero: bool,
) -> Result<Vec<Atom>, LivePhotoError> {
    if start > end || end > data.len() {
        return Err(atom_error(context, start, "container bounds exceed input"));
    }
    let mut atoms = Vec::new();
    let mut position = start;
    while position < end {
        if end - position < 8 {
            return Err(atom_error(context, position, "truncated atom header"));
        }
        let size32 = read_u32_at(data, position, context)?;
        let kind = data[position + 4..position + 8]
            .try_into()
            .expect("fixed atom type range");
        let (size, header_size) = match size32 {
            0 if allow_terminal_size_zero => (end - position, 8),
            0 => {
                return Err(atom_error(
                    context,
                    position,
                    "zero-sized atom is only valid at top level",
                ))
            }
            1 => {
                if end - position < 16 {
                    return Err(atom_error(context, position, "truncated extended atom"));
                }
                let extended = read_u64_at(data, position + 8, context)?;
                let size = usize::try_from(extended).map_err(|_| {
                    atom_error(context, position, "extended atom size exceeds platform")
                })?;
                (size, 16)
            }
            value => (value as usize, 8),
        };
        if size < header_size {
            return Err(atom_error(
                context,
                position,
                "atom is smaller than its header",
            ));
        }
        let atom_end = position
            .checked_add(size)
            .ok_or_else(|| atom_error(context, position, "atom size overflow"))?;
        if atom_end > end {
            return Err(atom_error(
                context,
                position,
                "atom extends past its parent",
            ));
        }
        if size32 == 0 && atom_end != end {
            return Err(atom_error(
                context,
                position,
                "zero-sized atom is not terminal",
            ));
        }
        atoms.push(Atom {
            kind,
            start: position,
            size,
            header_size,
        });
        position = atom_end;
    }
    Ok(atoms)
}

fn atom_error(context: &str, offset: usize, reason: impl Into<String>) -> LivePhotoError {
    LivePhotoError::MalformedAtom {
        context: context.to_string(),
        offset: offset as u64,
        reason: reason.into(),
    }
}

fn parse_mvhd(data: &[u8], atom: Atom) -> Result<(u32, u64, u32), LivePhotoError> {
    let payload = checked_payload(data, atom, "mvhd")?;
    if payload.len() < 4 {
        return Err(atom_error("mvhd", atom.start, "missing full-box header"));
    }
    let (timescale_offset, duration_offset, duration_size) = match payload[0] {
        0 => (12usize, 16usize, 4usize),
        1 => (20usize, 24usize, 8usize),
        version => {
            return Err(LivePhotoError::UnsupportedMov {
                reason: format!("unsupported mvhd version {version}"),
            })
        }
    };
    if payload.len() < duration_offset + duration_size || payload.len() < 4 {
        return Err(atom_error("mvhd", atom.start, "truncated timing fields"));
    }
    let timescale = read_u32_slice(payload, timescale_offset, "mvhd")?;
    let duration = if duration_size == 4 {
        u64::from(read_u32_slice(payload, duration_offset, "mvhd")?)
    } else {
        read_u64_slice(payload, duration_offset, "mvhd")?
    };
    if payload.len() < 4 {
        return Err(atom_error("mvhd", atom.start, "missing next_track_ID"));
    }
    let next_track_id = read_u32_slice(payload, payload.len() - 4, "mvhd")?;
    Ok((timescale, duration, next_track_id))
}

fn parse_track_info(data: &[u8], trak: Atom) -> Result<TrackInfo, LivePhotoError> {
    let children = parse_atom_sequence(data, trak.payload_start(), trak.end(), "trak", false)?;
    let tkhd = unique_child(&children, *b"tkhd", "trak/tkhd")?;
    let mdia = unique_child(&children, *b"mdia", "trak/mdia")?;
    let track_id = parse_tkhd_track_id(data, tkhd)?;
    let mdia_children =
        parse_atom_sequence(data, mdia.payload_start(), mdia.end(), "trak/mdia", false)?;
    let hdlr = unique_child(&mdia_children, *b"hdlr", "trak/mdia/hdlr")?;
    let payload = checked_payload(data, hdlr, "hdlr")?;
    if payload.len() < 12 {
        return Err(atom_error("hdlr", hdlr.start, "truncated handler type"));
    }
    let handler = payload[8..12].try_into().expect("fixed handler type range");
    Ok(TrackInfo {
        atom: trak,
        track_id,
        handler,
    })
}

fn parse_tkhd_track_id(data: &[u8], tkhd: Atom) -> Result<u32, LivePhotoError> {
    let payload = checked_payload(data, tkhd, "tkhd")?;
    if payload.len() < 4 {
        return Err(atom_error("tkhd", tkhd.start, "missing full-box header"));
    }
    let offset = match payload[0] {
        0 => 12,
        1 => 20,
        version => {
            return Err(LivePhotoError::UnsupportedMov {
                reason: format!("unsupported tkhd version {version}"),
            })
        }
    };
    read_u32_slice(payload, offset, "tkhd")
}

fn validate_track_chunk_offsets(
    data: &[u8],
    track: &TrackInfo,
    mdat_payloads: &[(usize, usize)],
) -> Result<(), LivePhotoError> {
    let Some(stbl) = find_track_stbl(data, track.atom)? else {
        return Err(LivePhotoError::UnsupportedMov {
            reason: format!("track {} has no sample table", track.track_id),
        });
    };
    let children = parse_atom_sequence(
        data,
        stbl.payload_start(),
        stbl.end(),
        "trak/mdia/minf/stbl",
        false,
    )?;
    let mut found = false;
    for atom in children {
        if atom.kind != *b"stco" && atom.kind != *b"co64" {
            continue;
        }
        found = true;
        let payload = checked_payload(data, atom, "chunk offsets")?;
        if payload.len() < 8 {
            return Err(atom_error(
                "chunk offsets",
                atom.start,
                "truncated entry count",
            ));
        }
        let count = read_u32_slice(payload, 4, "chunk offsets")? as usize;
        let width = if atom.kind == *b"stco" { 4 } else { 8 };
        let required =
            8usize
                .checked_add(count.checked_mul(width).ok_or_else(|| {
                    atom_error("chunk offsets", atom.start, "entry table overflow")
                })?)
                .ok_or_else(|| atom_error("chunk offsets", atom.start, "table overflow"))?;
        if required != payload.len() {
            return Err(atom_error(
                "chunk offsets",
                atom.start,
                "entry table length mismatch",
            ));
        }
        for index in 0..count {
            let offset_position = 8 + index * width;
            let offset = if width == 4 {
                u64::from(read_u32_slice(payload, offset_position, "stco")?)
            } else {
                read_u64_slice(payload, offset_position, "co64")?
            };
            let offset = usize::try_from(offset).map_err(|_| {
                atom_error("chunk offsets", atom.start, "chunk offset exceeds platform")
            })?;
            if !mdat_payloads
                .iter()
                .any(|(start, end)| offset >= *start && offset < *end)
            {
                return Err(LivePhotoError::UnsupportedMov {
                    reason: format!(
                        "track {} chunk offset {} is outside an mdat payload before moov",
                        track.track_id, offset
                    ),
                });
            }
        }
    }
    if !found {
        return Err(LivePhotoError::UnsupportedMov {
            reason: format!("track {} has no stco/co64", track.track_id),
        });
    }
    Ok(())
}

fn find_track_stbl(data: &[u8], trak: Atom) -> Result<Option<Atom>, LivePhotoError> {
    let track_children =
        parse_atom_sequence(data, trak.payload_start(), trak.end(), "trak", false)?;
    let Some(mdia) = track_children
        .iter()
        .copied()
        .find(|atom| atom.kind == *b"mdia")
    else {
        return Ok(None);
    };
    let mdia_children =
        parse_atom_sequence(data, mdia.payload_start(), mdia.end(), "trak/mdia", false)?;
    let Some(minf) = mdia_children
        .iter()
        .copied()
        .find(|atom| atom.kind == *b"minf")
    else {
        return Ok(None);
    };
    let minf_children = parse_atom_sequence(
        data,
        minf.payload_start(),
        minf.end(),
        "trak/mdia/minf",
        false,
    )?;
    Ok(minf_children
        .iter()
        .copied()
        .find(|atom| atom.kind == *b"stbl"))
}

fn read_movie_content_identifier(data: &[u8], moov: &Atom) -> Result<String, LivePhotoError> {
    let moov_children = parse_atom_sequence(data, moov.payload_start(), moov.end(), "moov", false)?;
    let mut meta_atoms = Vec::new();
    for child in &moov_children {
        if child.kind == *b"meta" {
            meta_atoms.push(*child);
        } else if child.kind == *b"udta" {
            let udta_children =
                parse_atom_sequence(data, child.payload_start(), child.end(), "moov/udta", false)?;
            meta_atoms.extend(
                udta_children
                    .into_iter()
                    .filter(|atom| atom.kind == *b"meta"),
            );
        }
    }

    let mut identifiers = Vec::new();
    for meta in meta_atoms {
        if let Some(identifier) = read_identifier_from_meta(data, meta)? {
            identifiers.push(identifier);
        }
    }
    let Some(first) = identifiers.first().cloned() else {
        return Err(LivePhotoError::MissingContentIdentifier);
    };
    if let Some(other) = identifiers.iter().find(|value| **value != first) {
        return Err(LivePhotoError::VerificationFailed {
            field: "movie content identifiers".to_string(),
            expected: first,
            actual: other.clone(),
        });
    }
    validate_asset_identifier(&first)?;
    Ok(first)
}

fn read_identifier_from_meta(data: &[u8], meta: Atom) -> Result<Option<String>, LivePhotoError> {
    let payload = checked_payload(data, meta, "meta")?;
    if payload.len() < 4 {
        return Err(atom_error("meta", meta.start, "missing full-box header"));
    }
    if payload[0] != 0 {
        return Err(LivePhotoError::UnsupportedMov {
            reason: format!("unsupported movie metadata version {}", payload[0]),
        });
    }
    let children = parse_atom_sequence(data, meta.payload_start() + 4, meta.end(), "meta", false)?;
    let Some(keys) = children.iter().copied().find(|atom| atom.kind == *b"keys") else {
        return Ok(None);
    };
    let Some(ilst) = children.iter().copied().find(|atom| atom.kind == *b"ilst") else {
        return Ok(None);
    };
    let key_names = parse_movie_metadata_keys(data, keys)?;
    let matching_indices: Vec<u32> = key_names
        .iter()
        .enumerate()
        .filter(|(_, (namespace, name))| namespace == b"mdta" && name == CONTENT_IDENTIFIER_KEY)
        .map(|(index, _)| (index + 1) as u32)
        .collect();
    if matching_indices.is_empty() {
        return Ok(None);
    }
    let ilst_children =
        parse_atom_sequence(data, ilst.payload_start(), ilst.end(), "meta/ilst", false)?;
    let mut values = Vec::new();
    for item in ilst_children {
        let item_index = u32::from_be_bytes(item.kind);
        if !matching_indices.contains(&item_index) {
            continue;
        }
        let item_children = parse_atom_sequence(
            data,
            item.payload_start(),
            item.end(),
            "meta/ilst/item",
            false,
        )?;
        for data_atom in item_children
            .iter()
            .copied()
            .filter(|atom| atom.kind == *b"data")
        {
            let payload = checked_payload(data, data_atom, "meta/ilst/item/data")?;
            if payload.len() < 8 {
                return Err(atom_error(
                    "meta/ilst/item/data",
                    data_atom.start,
                    "truncated data header",
                ));
            }
            let data_type = read_u32_slice(payload, 0, "metadata data type")? & 0x00ff_ffff;
            if data_type != 1 && data_type != 0 {
                return Err(LivePhotoError::UnsupportedMov {
                    reason: format!(
                        "content identifier has unsupported metadata data type {data_type}"
                    ),
                });
            }
            let raw = trim_nul(&payload[8..]);
            let value =
                std::str::from_utf8(raw).map_err(|error| LivePhotoError::VerificationFailed {
                    field: "movie content identifier UTF-8".to_string(),
                    expected: "valid UTF-8".to_string(),
                    actual: error.to_string(),
                })?;
            values.push(value.to_string());
        }
    }
    let Some(first) = values.first().cloned() else {
        return Ok(None);
    };
    if let Some(other) = values.iter().find(|value| **value != first) {
        return Err(LivePhotoError::VerificationFailed {
            field: "duplicate content identifier values".to_string(),
            expected: first,
            actual: other.clone(),
        });
    }
    Ok(Some(first))
}

fn parse_movie_metadata_keys(
    data: &[u8],
    keys: Atom,
) -> Result<Vec<([u8; 4], String)>, LivePhotoError> {
    let payload = checked_payload(data, keys, "meta/keys")?;
    if payload.len() < 8 {
        return Err(atom_error("meta/keys", keys.start, "truncated key table"));
    }
    if payload[0] != 0 {
        return Err(LivePhotoError::UnsupportedMov {
            reason: format!("unsupported movie metadata keys version {}", payload[0]),
        });
    }
    let count = read_u32_slice(payload, 4, "meta/keys")? as usize;
    let mut position = 8usize;
    let mut result = Vec::with_capacity(count);
    for _ in 0..count {
        if position + 8 > payload.len() {
            return Err(atom_error(
                "meta/keys",
                keys.start + position,
                "truncated key",
            ));
        }
        let size = read_u32_slice(payload, position, "meta/keys entry")? as usize;
        if size < 8
            || position
                .checked_add(size)
                .is_none_or(|end| end > payload.len())
        {
            return Err(atom_error(
                "meta/keys",
                keys.start + position,
                "invalid key entry size",
            ));
        }
        let namespace = payload[position + 4..position + 8]
            .try_into()
            .expect("fixed namespace range");
        let name = std::str::from_utf8(&payload[position + 8..position + size])
            .map_err(|error| atom_error("meta/keys", keys.start + position, error.to_string()))?
            .to_string();
        result.push((namespace, name));
        position += size;
    }
    if position != payload.len() {
        return Err(atom_error(
            "meta/keys",
            keys.start + position,
            "trailing bytes after declared keys",
        ));
    }
    Ok(result)
}

fn trim_nul(mut bytes: &[u8]) -> &[u8] {
    while bytes.last() == Some(&0) {
        bytes = &bytes[..bytes.len() - 1];
    }
    bytes
}

fn choose_metadata_track_id(layout: &MovieLayout) -> Result<u32, LivePhotoError> {
    let max_id = layout
        .tracks
        .iter()
        .map(|track| track.track_id)
        .max()
        .unwrap_or(0);
    let mut candidate = if layout.next_track_id > max_id
        && !layout
            .tracks
            .iter()
            .any(|track| track.track_id == layout.next_track_id)
    {
        layout.next_track_id
    } else {
        max_id
            .checked_add(1)
            .ok_or_else(|| LivePhotoError::IntegerOverflow {
                context: "metadata track ID".to_string(),
            })?
    };
    if candidate == 0 {
        candidate = 1;
    }
    candidate
        .checked_add(1)
        .ok_or_else(|| LivePhotoError::IntegerOverflow {
            context: "mvhd next_track_ID".to_string(),
        })?;
    Ok(candidate)
}

fn rebuild_moov_with_track(
    data: &[u8],
    layout: &MovieLayout,
    metadata_track: &[u8],
    metadata_track_id: u32,
) -> Result<Vec<u8>, LivePhotoError> {
    let next_track_id =
        metadata_track_id
            .checked_add(1)
            .ok_or_else(|| LivePhotoError::IntegerOverflow {
                context: "mvhd next_track_ID".to_string(),
            })?;
    let last_trak_index = layout
        .moov_children
        .iter()
        .rposition(|atom| atom.kind == *b"trak")
        .ok_or_else(|| LivePhotoError::UnsupportedMov {
            reason: "movie has no track insertion point".to_string(),
        })?;

    let mut payload = Vec::with_capacity(
        layout
            .moov
            .size
            .saturating_sub(layout.moov.header_size)
            .saturating_add(metadata_track.len()),
    );
    for (index, child) in layout.moov_children.iter().copied().enumerate() {
        if child == layout.mvhd {
            let mut mvhd = data[child.start..child.end()].to_vec();
            if mvhd.len() < child.header_size + 4 {
                return Err(atom_error("mvhd", child.start, "missing next_track_ID"));
            }
            let offset = mvhd.len() - 4;
            mvhd[offset..].copy_from_slice(&next_track_id.to_be_bytes());
            payload.extend_from_slice(&mvhd);
        } else {
            payload.extend_from_slice(&data[child.start..child.end()]);
        }
        if index == last_trak_index {
            payload.extend_from_slice(metadata_track);
        }
    }
    make_atom(*b"moov", &payload)
}

fn build_metadata_track(
    metadata_track_id: u32,
    video_track_id: u32,
    movie_timescale: u32,
    still_time: u32,
    sample_offset: u32,
) -> Result<Vec<u8>, LivePhotoError> {
    let track_duration =
        still_time
            .checked_add(1)
            .ok_or_else(|| LivePhotoError::IntegerOverflow {
                context: "metadata track duration".to_string(),
            })?;

    let tkhd = build_tkhd(metadata_track_id, track_duration)?;
    let edts = build_edts(still_time)?;
    let cdsc = make_atom(*b"cdsc", &video_track_id.to_be_bytes())?;
    let tref = make_atom(*b"tref", &cdsc)?;
    let mdia = build_metadata_mdia(movie_timescale, sample_offset)?;

    let mut payload = Vec::with_capacity(tkhd.len() + edts.len() + tref.len() + mdia.len());
    payload.extend_from_slice(&tkhd);
    payload.extend_from_slice(&edts);
    payload.extend_from_slice(&tref);
    payload.extend_from_slice(&mdia);
    make_atom(*b"trak", &payload)
}

fn build_tkhd(track_id: u32, duration: u32) -> Result<Vec<u8>, LivePhotoError> {
    let mut body = Vec::with_capacity(80);
    push_u32(&mut body, 0); // creation time
    push_u32(&mut body, 0); // modification time
    push_u32(&mut body, track_id);
    push_u32(&mut body, 0); // reserved
    push_u32(&mut body, duration);
    body.extend_from_slice(&[0; 8]);
    push_u16(&mut body, 0); // layer
    push_u16(&mut body, 0); // alternate group
    push_u16(&mut body, 0); // volume (metadata is not aural)
    push_u16(&mut body, 0);
    for matrix_value in [0x0001_0000u32, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000] {
        push_u32(&mut body, matrix_value);
    }
    push_u32(&mut body, 0); // width 16.16
    push_u32(&mut body, 0); // height 16.16
    make_full_atom(*b"tkhd", 0, 0x000003, &body)
}

fn build_edts(still_time: u32) -> Result<Vec<u8>, LivePhotoError> {
    let mut body = Vec::with_capacity(4 + 2 * 12);
    push_u32(&mut body, 2);
    push_u32(&mut body, still_time);
    push_i32(&mut body, -1);
    push_i16(&mut body, 1);
    push_i16(&mut body, 0);
    push_u32(&mut body, 1);
    push_i32(&mut body, 0);
    push_i16(&mut body, 1);
    push_i16(&mut body, 0);
    let elst = make_full_atom(*b"elst", 0, 0, &body)?;
    make_atom(*b"edts", &elst)
}

fn build_metadata_mdia(
    movie_timescale: u32,
    sample_offset: u32,
) -> Result<Vec<u8>, LivePhotoError> {
    let mut mdhd_body = Vec::with_capacity(20);
    push_u32(&mut mdhd_body, 0);
    push_u32(&mut mdhd_body, 0);
    push_u32(&mut mdhd_body, movie_timescale);
    push_u32(&mut mdhd_body, 1);
    push_u16(&mut mdhd_body, 0x55c4); // ISO-639-2/T "und"
    push_u16(&mut mdhd_body, 0);
    let mdhd = make_full_atom(*b"mdhd", 0, 0, &mdhd_body)?;

    let mut hdlr_body = Vec::new();
    push_u32(&mut hdlr_body, 0);
    hdlr_body.extend_from_slice(b"meta");
    hdlr_body.extend_from_slice(&[0; 12]);
    hdlr_body.extend_from_slice(b"GIFP Core Metadata\0");
    let hdlr = make_full_atom(*b"hdlr", 0, 0, &hdlr_body)?;
    let minf = build_metadata_minf(sample_offset)?;

    let mut payload = Vec::with_capacity(mdhd.len() + hdlr.len() + minf.len());
    payload.extend_from_slice(&mdhd);
    payload.extend_from_slice(&hdlr);
    payload.extend_from_slice(&minf);
    make_atom(*b"mdia", &payload)
}

fn build_metadata_minf(sample_offset: u32) -> Result<Vec<u8>, LivePhotoError> {
    let mut gmin_body = Vec::with_capacity(12);
    push_u16(&mut gmin_body, 0x0040); // Apple Live Photo metadata graphics mode
    push_u16(&mut gmin_body, 0x8000);
    push_u16(&mut gmin_body, 0x8000);
    push_u16(&mut gmin_body, 0x8000);
    push_u16(&mut gmin_body, 0); // balance
    push_u16(&mut gmin_body, 0);
    let gmin = make_full_atom(*b"gmin", 0, 0, &gmin_body)?;
    let gmhd = make_atom(*b"gmhd", &gmin)?;

    let url = make_full_atom(*b"url ", 0, 1, &[])?;
    let mut dref_body = Vec::with_capacity(4 + url.len());
    push_u32(&mut dref_body, 1);
    dref_body.extend_from_slice(&url);
    let dref = make_full_atom(*b"dref", 0, 0, &dref_body)?;
    let dinf = make_atom(*b"dinf", &dref)?;
    let stbl = build_metadata_stbl(sample_offset)?;

    let mut payload = Vec::with_capacity(gmhd.len() + dinf.len() + stbl.len());
    payload.extend_from_slice(&gmhd);
    payload.extend_from_slice(&dinf);
    payload.extend_from_slice(&stbl);
    make_atom(*b"minf", &payload)
}

fn build_metadata_stbl(sample_offset: u32) -> Result<Vec<u8>, LivePhotoError> {
    let mut keyd_payload = Vec::with_capacity(4 + STILL_IMAGE_TIME_KEY.len());
    keyd_payload.extend_from_slice(b"mdta");
    keyd_payload.extend_from_slice(STILL_IMAGE_TIME_KEY.as_bytes());
    let keyd = make_atom(*b"keyd", &keyd_payload)?;

    let mut dtyp_payload = Vec::with_capacity(8);
    push_u32(&mut dtyp_payload, 0); // well-known datatype namespace
    push_u32(&mut dtyp_payload, 65); // signed 8-bit integer
    let dtyp = make_atom(*b"dtyp", &dtyp_payload)?;

    let mut key_payload = Vec::with_capacity(keyd.len() + dtyp.len());
    key_payload.extend_from_slice(&keyd);
    key_payload.extend_from_slice(&dtyp);
    let key = make_atom([0, 0, 0, 1], &key_payload)?;
    let keys = make_atom(*b"keys", &key)?;

    let mut mebx_payload = Vec::with_capacity(8 + keys.len());
    mebx_payload.extend_from_slice(&[0; 6]);
    push_u16(&mut mebx_payload, 1);
    mebx_payload.extend_from_slice(&keys);
    let mebx = make_atom(*b"mebx", &mebx_payload)?;

    let mut stsd_body = Vec::with_capacity(4 + mebx.len());
    push_u32(&mut stsd_body, 1);
    stsd_body.extend_from_slice(&mebx);
    let stsd = make_full_atom(*b"stsd", 0, 0, &stsd_body)?;

    let mut stts_body = Vec::with_capacity(12);
    push_u32(&mut stts_body, 1);
    push_u32(&mut stts_body, 1);
    push_u32(&mut stts_body, 1);
    let stts = make_full_atom(*b"stts", 0, 0, &stts_body)?;

    let mut stsc_body = Vec::with_capacity(16);
    push_u32(&mut stsc_body, 1);
    push_u32(&mut stsc_body, 1);
    push_u32(&mut stsc_body, 1);
    push_u32(&mut stsc_body, 1);
    let stsc = make_full_atom(*b"stsc", 0, 0, &stsc_body)?;

    let mut stsz_body = Vec::with_capacity(8);
    push_u32(&mut stsz_body, 1);
    push_u32(&mut stsz_body, 1);
    let stsz = make_full_atom(*b"stsz", 0, 0, &stsz_body)?;

    let mut stco_body = Vec::with_capacity(8);
    push_u32(&mut stco_body, 1);
    push_u32(&mut stco_body, sample_offset);
    let stco = make_full_atom(*b"stco", 0, 0, &stco_body)?;

    let mut payload =
        Vec::with_capacity(stsd.len() + stts.len() + stsc.len() + stsz.len() + stco.len());
    payload.extend_from_slice(&stsd);
    payload.extend_from_slice(&stts);
    payload.extend_from_slice(&stsc);
    payload.extend_from_slice(&stsz);
    payload.extend_from_slice(&stco);
    make_atom(*b"stbl", &payload)
}

fn make_atom(kind: [u8; 4], payload: &[u8]) -> Result<Vec<u8>, LivePhotoError> {
    let size = payload
        .len()
        .checked_add(8)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| LivePhotoError::IntegerOverflow {
            context: format!("{} atom", fourcc(kind)),
        })?;
    let mut atom = Vec::with_capacity(size as usize);
    push_u32(&mut atom, size);
    atom.extend_from_slice(&kind);
    atom.extend_from_slice(payload);
    Ok(atom)
}

fn make_full_atom(
    kind: [u8; 4],
    version: u8,
    flags: u32,
    body: &[u8],
) -> Result<Vec<u8>, LivePhotoError> {
    if flags > 0x00ff_ffff {
        return Err(LivePhotoError::IntegerOverflow {
            context: format!("{} full-box flags", fourcc(kind)),
        });
    }
    let mut payload = Vec::with_capacity(4 + body.len());
    payload.push(version);
    payload.extend_from_slice(&[
        ((flags >> 16) & 0xff) as u8,
        ((flags >> 8) & 0xff) as u8,
        (flags & 0xff) as u8,
    ]);
    payload.extend_from_slice(body);
    make_atom(kind, &payload)
}

fn fourcc(kind: [u8; 4]) -> String {
    kind.iter()
        .map(|byte| {
            if byte.is_ascii_graphic() || *byte == b' ' {
                char::from(*byte)
            } else {
                '.'
            }
        })
        .collect()
}

#[derive(Clone, Copy, Debug)]
struct StillTrackInfo {
    track_id: u32,
    still_time_movie_units: u64,
    sample_offset: usize,
}

fn find_still_image_track(
    data: &[u8],
    layout: &MovieLayout,
    strict: bool,
) -> Result<Option<StillTrackInfo>, LivePhotoError> {
    let mut matching = Vec::new();
    for track in layout
        .tracks
        .iter()
        .filter(|track| track.handler == *b"meta")
    {
        if let Some(info) = inspect_still_track(data, layout, track, strict)? {
            matching.push(info);
        }
    }
    if matching.len() > 1 {
        return Err(LivePhotoError::VerificationFailed {
            field: "still-image-time track count".to_string(),
            expected: "1".to_string(),
            actual: matching.len().to_string(),
        });
    }
    Ok(matching.into_iter().next())
}

fn inspect_still_track(
    data: &[u8],
    layout: &MovieLayout,
    track: &TrackInfo,
    strict: bool,
) -> Result<Option<StillTrackInfo>, LivePhotoError> {
    let stbl =
        find_track_stbl(data, track.atom)?.ok_or_else(|| LivePhotoError::UnsupportedMov {
            reason: format!("metadata track {} has no stbl", track.track_id),
        })?;
    let stbl_children = parse_atom_sequence(
        data,
        stbl.payload_start(),
        stbl.end(),
        "metadata stbl",
        false,
    )?;
    let Some(stsd) = stbl_children
        .iter()
        .copied()
        .find(|atom| atom.kind == *b"stsd")
    else {
        return Ok(None);
    };
    if !stsd_declares_still_image_time(data, stsd)? {
        return Ok(None);
    }

    // Even the relaxed path used by the finalizer parses the declaration. It
    // therefore refuses a pre-existing key rather than silently adding a
    // duplicate track around malformed metadata.
    if !strict {
        return Ok(Some(StillTrackInfo {
            track_id: track.track_id,
            still_time_movie_units: 0,
            sample_offset: 0,
        }));
    }

    let track_children = parse_atom_sequence(
        data,
        track.atom.payload_start(),
        track.atom.end(),
        "metadata trak",
        false,
    )?;
    let tkhd = unique_child(&track_children, *b"tkhd", "metadata trak/tkhd")?;
    let edts = unique_child(&track_children, *b"edts", "metadata trak/edts")?;
    let tref = unique_child(&track_children, *b"tref", "metadata trak/tref")?;
    let mdia = unique_child(&track_children, *b"mdia", "metadata trak/mdia")?;

    let still_time = verify_edit_list(data, edts)?;
    if still_time >= layout.movie_duration
        || still_time
            .checked_add(1)
            .is_none_or(|end| end > layout.movie_duration)
    {
        return Err(LivePhotoError::InvalidStillTime {
            still_time,
            duration: layout.movie_duration,
        });
    }
    let tkhd_duration = parse_tkhd_duration(data, tkhd)?;
    verify_equal("metadata tkhd duration", still_time + 1, tkhd_duration)?;
    verify_cdsc(data, tref, layout.video_track_id)?;

    let mdia_children = parse_atom_sequence(
        data,
        mdia.payload_start(),
        mdia.end(),
        "metadata trak/mdia",
        false,
    )?;
    let mdhd = unique_child(&mdia_children, *b"mdhd", "metadata mdhd")?;
    let (media_timescale, media_duration) = parse_mdhd(data, mdhd)?;
    verify_equal(
        "metadata media timescale",
        u64::from(layout.movie_timescale),
        u64::from(media_timescale),
    )?;
    verify_equal("metadata media duration", 1u64, media_duration)?;

    let stts = unique_child(&stbl_children, *b"stts", "metadata stts")?;
    let stsc = unique_child(&stbl_children, *b"stsc", "metadata stsc")?;
    let stsz = unique_child(&stbl_children, *b"stsz", "metadata stsz")?;
    let stco = unique_child(&stbl_children, *b"stco", "metadata stco")?;
    verify_single_sample_stts(data, stts)?;
    verify_single_sample_stsc(data, stsc)?;
    verify_single_byte_stsz(data, stsz)?;
    let sample_offset = read_single_stco(data, stco)?;
    if !layout
        .mdat_payloads
        .iter()
        .any(|(start, end)| sample_offset >= *start && sample_offset < *end)
    {
        return Err(LivePhotoError::VerificationFailed {
            field: "metadata sample offset".to_string(),
            expected: "inside mdat".to_string(),
            actual: sample_offset.to_string(),
        });
    }
    let sample =
        data.get(sample_offset)
            .copied()
            .ok_or_else(|| LivePhotoError::VerificationFailed {
                field: "metadata sample byte".to_string(),
                expected: "0xff".to_string(),
                actual: "out of bounds".to_string(),
            })?;
    if sample != 0xff {
        return Err(LivePhotoError::VerificationFailed {
            field: "metadata sample byte".to_string(),
            expected: "0xff".to_string(),
            actual: format!("0x{sample:02x}"),
        });
    }

    Ok(Some(StillTrackInfo {
        track_id: track.track_id,
        still_time_movie_units: still_time,
        sample_offset,
    }))
}

fn stsd_declares_still_image_time(data: &[u8], stsd: Atom) -> Result<bool, LivePhotoError> {
    let payload = checked_payload(data, stsd, "metadata stsd")?;
    if payload.len() < 8 {
        return Err(atom_error("metadata stsd", stsd.start, "truncated table"));
    }
    if payload[0] != 0 {
        return Err(LivePhotoError::UnsupportedMov {
            reason: format!("unsupported stsd version {}", payload[0]),
        });
    }
    let count = read_u32_slice(payload, 4, "metadata stsd")? as usize;
    let mut position = 8usize;
    let mut found = false;
    for _ in 0..count {
        if position + 8 > payload.len() {
            return Err(atom_error(
                "metadata stsd",
                stsd.start + position,
                "truncated sample description",
            ));
        }
        let size = read_u32_slice(payload, position, "metadata stsd entry")? as usize;
        if size < 16
            || position
                .checked_add(size)
                .is_none_or(|end| end > payload.len())
        {
            return Err(atom_error(
                "metadata stsd",
                stsd.start + position,
                "invalid sample description size",
            ));
        }
        if payload[position + 4..position + 8] == *b"mebx" {
            let entry_absolute = stsd.payload_start() + position;
            let key_boxes = parse_atom_sequence(
                data,
                entry_absolute + 16,
                entry_absolute + size,
                "stsd/mebx",
                false,
            )?;
            for keys in key_boxes
                .iter()
                .copied()
                .filter(|atom| atom.kind == *b"keys")
            {
                if timed_keys_declare_still_image_time(data, keys)? {
                    found = true;
                }
            }
        }
        position += size;
    }
    if position != payload.len() {
        return Err(atom_error(
            "metadata stsd",
            stsd.start + position,
            "trailing bytes after sample descriptions",
        ));
    }
    Ok(found)
}

fn timed_keys_declare_still_image_time(data: &[u8], keys: Atom) -> Result<bool, LivePhotoError> {
    let key_atoms =
        parse_atom_sequence(data, keys.payload_start(), keys.end(), "mebx/keys", false)?;
    let mut found = false;
    for key in key_atoms {
        let local_id = u32::from_be_bytes(key.kind);
        if local_id == 0 || local_id == u32::MAX {
            return Err(LivePhotoError::VerificationFailed {
                field: "timed metadata local key ID".to_string(),
                expected: "non-reserved ID".to_string(),
                actual: local_id.to_string(),
            });
        }
        let declarations =
            parse_atom_sequence(data, key.payload_start(), key.end(), "mebx/keys/key", false)?;
        let keyd = declarations
            .iter()
            .copied()
            .find(|atom| atom.kind == *b"keyd");
        let dtyp = declarations
            .iter()
            .copied()
            .find(|atom| atom.kind == *b"dtyp");
        let Some(keyd) = keyd else {
            continue;
        };
        let keyd_payload = checked_payload(data, keyd, "mebx keyd")?;
        if keyd_payload.len() < 4 {
            return Err(atom_error("mebx keyd", keyd.start, "truncated namespace"));
        }
        if keyd_payload[..4] != *b"mdta" {
            continue;
        }
        let name = std::str::from_utf8(&keyd_payload[4..]).map_err(|error| {
            atom_error("mebx keyd", keyd.start, format!("invalid UTF-8: {error}"))
        })?;
        if name != STILL_IMAGE_TIME_KEY {
            continue;
        }
        if found {
            return Err(LivePhotoError::VerificationFailed {
                field: "still-image-time key declaration count".to_string(),
                expected: "1".to_string(),
                actual: "more than 1".to_string(),
            });
        }
        let dtyp = dtyp.ok_or_else(|| LivePhotoError::VerificationFailed {
            field: "still-image-time dtyp".to_string(),
            expected: "well-known SInt8 (65)".to_string(),
            actual: "missing".to_string(),
        })?;
        let dtyp_payload = checked_payload(data, dtyp, "mebx dtyp")?;
        if dtyp_payload.len() != 8 {
            return Err(LivePhotoError::VerificationFailed {
                field: "still-image-time dtyp length".to_string(),
                expected: "8".to_string(),
                actual: dtyp_payload.len().to_string(),
            });
        }
        let namespace = read_u32_slice(dtyp_payload, 0, "mebx dtyp")?;
        let datatype = read_u32_slice(dtyp_payload, 4, "mebx dtyp")?;
        if namespace != 0 || datatype != 65 {
            return Err(LivePhotoError::VerificationFailed {
                field: "still-image-time dtyp".to_string(),
                expected: "namespace=0,type=65".to_string(),
                actual: format!("namespace={namespace},type={datatype}"),
            });
        }
        found = true;
    }
    Ok(found)
}

fn verify_edit_list(data: &[u8], edts: Atom) -> Result<u64, LivePhotoError> {
    let children = parse_atom_sequence(
        data,
        edts.payload_start(),
        edts.end(),
        "metadata edts",
        false,
    )?;
    let elst = unique_child(&children, *b"elst", "metadata edts/elst")?;
    let payload = checked_payload(data, elst, "metadata elst")?;
    if payload.len() != 32 || payload[0] != 0 {
        return Err(LivePhotoError::VerificationFailed {
            field: "metadata edit list shape".to_string(),
            expected: "version 0 with two 12-byte entries".to_string(),
            actual: format!(
                "version={},bytes={}",
                payload.first().copied().unwrap_or(255),
                payload.len()
            ),
        });
    }
    verify_equal(
        "metadata edit count",
        2u64,
        u64::from(read_u32_slice(payload, 4, "elst")?),
    )?;
    let still_time = u64::from(read_u32_slice(payload, 8, "elst")?);
    let first_media_time = read_i32_slice(payload, 12, "elst")?;
    let first_rate_integer = read_i16_slice(payload, 16, "elst")?;
    let first_rate_fraction = read_i16_slice(payload, 18, "elst")?;
    let second_duration = read_u32_slice(payload, 20, "elst")?;
    let second_media_time = read_i32_slice(payload, 24, "elst")?;
    let second_rate_integer = read_i16_slice(payload, 28, "elst")?;
    let second_rate_fraction = read_i16_slice(payload, 30, "elst")?;
    if first_media_time != -1
        || first_rate_integer != 1
        || first_rate_fraction != 0
        || second_duration != 1
        || second_media_time != 0
        || second_rate_integer != 1
        || second_rate_fraction != 0
    {
        return Err(LivePhotoError::VerificationFailed {
            field: "metadata edit entries".to_string(),
            expected: "(still_time,-1,1.0),(1,0,1.0)".to_string(),
            actual: format!(
                "({still_time},{first_media_time},{first_rate_integer}.{first_rate_fraction}),({second_duration},{second_media_time},{second_rate_integer}.{second_rate_fraction})"
            ),
        });
    }
    Ok(still_time)
}

fn verify_cdsc(data: &[u8], tref: Atom, video_track_id: u32) -> Result<(), LivePhotoError> {
    let children = parse_atom_sequence(
        data,
        tref.payload_start(),
        tref.end(),
        "metadata tref",
        false,
    )?;
    let cdsc = unique_child(&children, *b"cdsc", "metadata tref/cdsc")?;
    let payload = checked_payload(data, cdsc, "metadata cdsc")?;
    if payload.len() != 4 {
        return Err(LivePhotoError::VerificationFailed {
            field: "metadata cdsc target count".to_string(),
            expected: "1".to_string(),
            actual: (payload.len() / 4).to_string(),
        });
    }
    let actual = read_u32_slice(payload, 0, "metadata cdsc")?;
    verify_equal(
        "metadata cdsc video track ID",
        u64::from(video_track_id),
        u64::from(actual),
    )
}

fn parse_mdhd(data: &[u8], mdhd: Atom) -> Result<(u32, u64), LivePhotoError> {
    let payload = checked_payload(data, mdhd, "mdhd")?;
    if payload.len() < 4 {
        return Err(atom_error("mdhd", mdhd.start, "missing full-box header"));
    }
    match payload[0] {
        0 => Ok((
            read_u32_slice(payload, 12, "mdhd")?,
            u64::from(read_u32_slice(payload, 16, "mdhd")?),
        )),
        1 => Ok((
            read_u32_slice(payload, 20, "mdhd")?,
            read_u64_slice(payload, 24, "mdhd")?,
        )),
        version => Err(LivePhotoError::UnsupportedMov {
            reason: format!("unsupported mdhd version {version}"),
        }),
    }
}

fn parse_tkhd_duration(data: &[u8], tkhd: Atom) -> Result<u64, LivePhotoError> {
    let payload = checked_payload(data, tkhd, "tkhd")?;
    if payload.len() < 4 {
        return Err(atom_error("tkhd", tkhd.start, "missing full-box header"));
    }
    match payload[0] {
        0 => Ok(u64::from(read_u32_slice(payload, 20, "tkhd")?)),
        1 => read_u64_slice(payload, 28, "tkhd"),
        version => Err(LivePhotoError::UnsupportedMov {
            reason: format!("unsupported tkhd version {version}"),
        }),
    }
}

fn verify_single_sample_stts(data: &[u8], atom: Atom) -> Result<(), LivePhotoError> {
    let payload = checked_payload(data, atom, "metadata stts")?;
    if payload.len() != 16 {
        return Err(table_shape_error("stts", payload.len(), 16));
    }
    let values = [
        read_u32_slice(payload, 4, "stts")?,
        read_u32_slice(payload, 8, "stts")?,
        read_u32_slice(payload, 12, "stts")?,
    ];
    if values != [1, 1, 1] {
        return Err(LivePhotoError::VerificationFailed {
            field: "metadata stts".to_string(),
            expected: "entry_count=1,sample_count=1,sample_delta=1".to_string(),
            actual: format!("{values:?}"),
        });
    }
    Ok(())
}

fn verify_single_sample_stsc(data: &[u8], atom: Atom) -> Result<(), LivePhotoError> {
    let payload = checked_payload(data, atom, "metadata stsc")?;
    if payload.len() != 20 {
        return Err(table_shape_error("stsc", payload.len(), 20));
    }
    let values = [
        read_u32_slice(payload, 4, "stsc")?,
        read_u32_slice(payload, 8, "stsc")?,
        read_u32_slice(payload, 12, "stsc")?,
        read_u32_slice(payload, 16, "stsc")?,
    ];
    if values != [1, 1, 1, 1] {
        return Err(LivePhotoError::VerificationFailed {
            field: "metadata stsc".to_string(),
            expected: "one chunk, one sample, description 1".to_string(),
            actual: format!("{values:?}"),
        });
    }
    Ok(())
}

fn verify_single_byte_stsz(data: &[u8], atom: Atom) -> Result<(), LivePhotoError> {
    let payload = checked_payload(data, atom, "metadata stsz")?;
    if payload.len() != 12 {
        return Err(table_shape_error("stsz", payload.len(), 12));
    }
    let sample_size = read_u32_slice(payload, 4, "stsz")?;
    let sample_count = read_u32_slice(payload, 8, "stsz")?;
    if sample_size != 1 || sample_count != 1 {
        return Err(LivePhotoError::VerificationFailed {
            field: "metadata stsz".to_string(),
            expected: "sample_size=1,sample_count=1".to_string(),
            actual: format!("sample_size={sample_size},sample_count={sample_count}"),
        });
    }
    Ok(())
}

fn read_single_stco(data: &[u8], atom: Atom) -> Result<usize, LivePhotoError> {
    let payload = checked_payload(data, atom, "metadata stco")?;
    if payload.len() != 12 || read_u32_slice(payload, 4, "stco")? != 1 {
        return Err(LivePhotoError::VerificationFailed {
            field: "metadata stco".to_string(),
            expected: "one 32-bit chunk offset".to_string(),
            actual: format!("{} payload bytes", payload.len()),
        });
    }
    Ok(read_u32_slice(payload, 8, "stco")? as usize)
}

fn table_shape_error(name: &str, actual: usize, expected: usize) -> LivePhotoError {
    LivePhotoError::VerificationFailed {
        field: format!("metadata {name} length"),
        expected: expected.to_string(),
        actual: actual.to_string(),
    }
}

fn verify_equal<T>(field: &str, expected: T, actual: T) -> Result<(), LivePhotoError>
where
    T: Eq + ToString,
{
    if expected == actual {
        Ok(())
    } else {
        Err(LivePhotoError::VerificationFailed {
            field: field.to_string(),
            expected: expected.to_string(),
            actual: actual.to_string(),
        })
    }
}

fn inspect_live_photo(
    jpeg: Option<&[u8]>,
    mov: &[u8],
    asset_identifier: &str,
) -> Result<LivePhotoReport, LivePhotoError> {
    validate_asset_identifier(asset_identifier)?;
    let layout = parse_movie_layout(mov)?;
    let mov_identifier = read_movie_content_identifier(mov, &layout.moov)?;
    if mov_identifier != asset_identifier {
        return Err(LivePhotoError::ContentIdentifierMismatch {
            expected: asset_identifier.to_string(),
            found: mov_identifier,
        });
    }
    let still_track = find_still_image_track(mov, &layout, true)?.ok_or_else(|| {
        LivePhotoError::VerificationFailed {
            field: "still-image-time track".to_string(),
            expected: "one complete meta/mebx track".to_string(),
            actual: "missing".to_string(),
        }
    })?;

    let (jpeg_bytes, jpeg_sha256, jpeg_scan_sha256) = if let Some(jpeg) = jpeg {
        let jpeg_identifier = extract_jpeg_asset_identifier(jpeg)?;
        if jpeg_identifier != asset_identifier {
            return Err(LivePhotoError::PairIdentifierMismatch {
                jpeg: jpeg_identifier,
                mov: asset_identifier.to_string(),
            });
        }
        let jpeg_layout = parse_jpeg_layout(jpeg)?;
        (
            Some(jpeg.len() as u64),
            Some(sha256_hex(jpeg)),
            Some(sha256_hex(&jpeg[jpeg_layout.scan_start..])),
        )
    } else {
        (None, None, None)
    };

    let mut report = LivePhotoReport {
        schema_version: LIVE_PHOTO_REPORT_SCHEMA_VERSION,
        pair_verified: jpeg.is_some(),
        asset_identifier: asset_identifier.to_string(),
        still_time_movie_units: still_track.still_time_movie_units,
        movie_timescale: layout.movie_timescale,
        video_track_id: layout.video_track_id,
        metadata_track_id: still_track.track_id,
        metadata_sample_offset: still_track.sample_offset as u64,
        jpeg_bytes,
        mov_bytes: mov.len() as u64,
        jpeg_sha256,
        jpeg_scan_sha256,
        mov_sha256: sha256_hex(mov),
        metadata_sample_sha256: sha256_hex(&[0xff]),
        contract_sha256: String::new(),
    };
    report.contract_sha256 = contract_sha256(&report);
    if !report.contract_is_closed() {
        return Err(LivePhotoError::VerificationFailed {
            field: "contract SHA-256 closure".to_string(),
            expected: report.contract_sha256.clone(),
            actual: contract_sha256(&report),
        });
    }
    Ok(report)
}

impl LivePhotoReport {
    /// Recomputes the canonical contract digest over all semantic fields and
    /// resource digests. This detects accidental report mutation after verify.
    pub fn contract_is_closed(&self) -> bool {
        self.contract_sha256 == contract_sha256(self)
    }
}

fn contract_sha256(report: &LivePhotoReport) -> String {
    let mut hasher = Sha256::new();
    hasher.update(CONTRACT_DOMAIN);
    hash_u16(&mut hasher, report.schema_version);
    hasher.update([u8::from(report.pair_verified)]);
    hash_string(&mut hasher, &report.asset_identifier);
    hash_u64(&mut hasher, report.still_time_movie_units);
    hash_u32(&mut hasher, report.movie_timescale);
    hash_u32(&mut hasher, report.video_track_id);
    hash_u32(&mut hasher, report.metadata_track_id);
    hash_u64(&mut hasher, report.metadata_sample_offset);
    hash_optional_u64(&mut hasher, report.jpeg_bytes);
    hash_u64(&mut hasher, report.mov_bytes);
    hash_optional_string(&mut hasher, report.jpeg_sha256.as_deref());
    hash_optional_string(&mut hasher, report.jpeg_scan_sha256.as_deref());
    hash_string(&mut hasher, &report.mov_sha256);
    hash_string(&mut hasher, &report.metadata_sample_sha256);
    format!("{:x}", hasher.finalize())
}

fn hash_string(hasher: &mut Sha256, value: &str) {
    hash_u64(hasher, value.len() as u64);
    hasher.update(value.as_bytes());
}

fn hash_optional_string(hasher: &mut Sha256, value: Option<&str>) {
    match value {
        Some(value) => {
            hasher.update([1]);
            hash_string(hasher, value);
        }
        None => hasher.update([0]),
    }
}

fn hash_optional_u64(hasher: &mut Sha256, value: Option<u64>) {
    match value {
        Some(value) => {
            hasher.update([1]);
            hash_u64(hasher, value);
        }
        None => hasher.update([0]),
    }
}

fn hash_u16(hasher: &mut Sha256, value: u16) {
    hasher.update(value.to_be_bytes());
}

fn hash_u32(hasher: &mut Sha256, value: u32) {
    hasher.update(value.to_be_bytes());
}

fn hash_u64(hasher: &mut Sha256, value: u64) {
    hasher.update(value.to_be_bytes());
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn extract_jpeg_asset_identifier(jpeg: &[u8]) -> Result<String, LivePhotoError> {
    let layout = parse_jpeg_layout(jpeg)?;
    if !layout.exif_found {
        return Err(LivePhotoError::InvalidMakerNote {
            reason: "JPEG has no EXIF APP1 segment".to_string(),
        });
    }
    let mut position = 2usize;
    let mut exif_tiff: Option<&[u8]> = None;
    while position < layout.scan_start {
        let marker_start = position;
        while position < layout.scan_start && jpeg[position] == 0xff {
            position += 1;
        }
        if position >= layout.scan_start {
            break;
        }
        let marker = jpeg[position];
        position += 1;
        if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            continue;
        }
        let length = usize::from(u16::from_be_bytes([
            *jpeg
                .get(position)
                .ok_or_else(|| LivePhotoError::InvalidJpeg {
                    offset: position as u64,
                    reason: "truncated segment length".to_string(),
                })?,
            *jpeg
                .get(position + 1)
                .ok_or_else(|| LivePhotoError::InvalidJpeg {
                    offset: position as u64,
                    reason: "truncated segment length".to_string(),
                })?,
        ]));
        let end = position
            .checked_add(length)
            .ok_or_else(|| LivePhotoError::InvalidJpeg {
                offset: marker_start as u64,
                reason: "segment length overflow".to_string(),
            })?;
        let payload_start = position + 2;
        if marker == 0xe1
            && jpeg
                .get(payload_start..payload_start.saturating_add(6))
                .is_some_and(|prefix| prefix == b"Exif\0\0")
        {
            if exif_tiff.is_some() {
                return Err(LivePhotoError::InvalidMakerNote {
                    reason: "JPEG contains multiple EXIF APP1 segments".to_string(),
                });
            }
            exif_tiff = jpeg.get(payload_start + 6..end);
        }
        position = end;
    }
    let tiff = exif_tiff.ok_or_else(|| LivePhotoError::InvalidMakerNote {
        reason: "EXIF APP1 payload is truncated".to_string(),
    })?;
    parse_outer_tiff_asset_identifier(tiff)
}

#[derive(Clone, Copy, Debug)]
enum TiffOrder {
    Big,
    Little,
}

fn parse_outer_tiff_asset_identifier(tiff: &[u8]) -> Result<String, LivePhotoError> {
    if tiff.len() < 8 {
        return Err(maker_error("truncated outer TIFF header"));
    }
    let order = match &tiff[..2] {
        b"MM" => TiffOrder::Big,
        b"II" => TiffOrder::Little,
        _ => return Err(maker_error("invalid outer TIFF byte order")),
    };
    if tiff_u16(tiff, 2, order)? != 42 {
        return Err(maker_error("invalid outer TIFF magic"));
    }
    let ifd0_offset = usize::try_from(tiff_u32(tiff, 4, order)?)
        .map_err(|_| maker_error("IFD0 offset exceeds platform"))?;
    let ifd0_entries = tiff_ifd_entries(tiff, ifd0_offset, order, "IFD0")?;
    let mut make: Option<String> = None;
    let mut exif_ifd_offset: Option<usize> = None;
    for entry in ifd0_entries {
        let tag = tiff_u16(tiff, entry, order)?;
        let field_type = tiff_u16(tiff, entry + 2, order)?;
        let count = tiff_u32(tiff, entry + 4, order)?;
        match tag {
            0x010f => {
                if make.is_some() || field_type != 2 || count == 0 {
                    return Err(maker_error("invalid or duplicate IFD0 Make tag"));
                }
                let value = tiff_entry_value(tiff, entry, field_type, count, order, "Make")?;
                let value = std::str::from_utf8(trim_nul(value))
                    .map_err(|error| maker_error(format!("Make is not UTF-8: {error}")))?;
                make = Some(value.to_string());
            }
            0x8769 => {
                if exif_ifd_offset.is_some() || field_type != 4 || count != 1 {
                    return Err(maker_error("invalid or duplicate IFD0 ExifIFDPointer tag"));
                }
                exif_ifd_offset = Some(
                    usize::try_from(tiff_u32(tiff, entry + 8, order)?)
                        .map_err(|_| maker_error("ExifIFDPointer exceeds platform"))?,
                );
            }
            _ => {}
        }
    }
    if make.as_deref() != Some("Apple") {
        return Err(maker_error(format!(
            "IFD0 Make must be Apple, found {:?}",
            make.as_deref()
        )));
    }
    let exif_ifd_offset = exif_ifd_offset.ok_or_else(|| maker_error("missing ExifIFDPointer"))?;
    let exif_entries = tiff_ifd_entries(tiff, exif_ifd_offset, order, "ExifIFD")?;
    let mut maker_note: Option<&[u8]> = None;
    for entry in exif_entries {
        if tiff_u16(tiff, entry, order)? != 0x927c {
            continue;
        }
        if maker_note.is_some() {
            return Err(maker_error("duplicate ExifIFD MakerNote tag"));
        }
        let field_type = tiff_u16(tiff, entry + 2, order)?;
        let count = tiff_u32(tiff, entry + 4, order)?;
        if field_type != 7 || count == 0 {
            return Err(maker_error("MakerNote must be non-empty UNDEFINED data"));
        }
        maker_note = Some(tiff_entry_value(
            tiff,
            entry,
            field_type,
            count,
            order,
            "MakerNote",
        )?);
    }
    parse_apple_maker_note_asset_identifier(
        maker_note.ok_or_else(|| maker_error("missing ExifIFD MakerNote"))?,
    )
}

fn parse_apple_maker_note_asset_identifier(note: &[u8]) -> Result<String, LivePhotoError> {
    // Native iPhone fixture signature. Bytes 10..14 are version/byte-order
    // (`00 01 MM`); the IFD entry count starts at byte 14. Unlike a TIFF
    // header there is no 42 magic or IFD pointer here. All out-of-line value
    // offsets in entries are relative to MakerNote byte zero.
    const SIGNATURE: &[u8; 14] = b"Apple iOS\0\0\x01MM";
    if !note.starts_with(SIGNATURE) {
        return Err(maker_error(
            "Apple MakerNote signature/version must be Apple iOS\\0\\0\\x01MM",
        ));
    }
    let count = usize::from(be_u16(note, SIGNATURE.len(), "Apple MakerNote")?);
    let entries_start = SIGNATURE.len() + 2;
    let entries_end =
        entries_start
            .checked_add(count.checked_mul(12).ok_or_else(|| {
                maker_error("Apple MakerNote entry table multiplication overflow")
            })?)
            .ok_or_else(|| maker_error("Apple MakerNote entry table overflow"))?;
    if entries_end
        .checked_add(4)
        .is_none_or(|end| end > note.len())
    {
        return Err(maker_error("truncated Apple MakerNote IFD"));
    }

    let mut identifier: Option<String> = None;
    for index in 0..count {
        let entry = entries_start + index * 12;
        let tag = be_u16(note, entry, "Apple MakerNote")?;
        if tag != 0x0011 {
            continue;
        }
        if identifier.is_some() {
            return Err(maker_error("duplicate Apple MakerNote key 0x0011"));
        }
        let field_type = be_u16(note, entry + 2, "Apple MakerNote")?;
        let value_count = be_u32(note, entry + 4, "Apple MakerNote")?;
        if field_type != 2 || value_count != 37 {
            return Err(maker_error(format!(
                "Apple key 0x0011 must be ASCII[37], found type {field_type} count {value_count}"
            )));
        }
        let value = tiff_entry_value(
            note,
            entry,
            field_type,
            value_count,
            TiffOrder::Big,
            "Apple key 0x0011",
        )?;
        if value.last() != Some(&0) || value[..value.len() - 1].contains(&0) {
            return Err(maker_error("Apple key 0x0011 must have one trailing NUL"));
        }
        let value = std::str::from_utf8(&value[..value.len() - 1])
            .map_err(|error| maker_error(format!("Apple key 0x0011 is not UTF-8: {error}")))?;
        validate_asset_identifier(value)?;
        identifier = Some(value.to_string());
    }
    identifier.ok_or_else(|| maker_error("Apple MakerNote has no key 0x0011"))
}

fn tiff_ifd_entries(
    data: &[u8],
    offset: usize,
    order: TiffOrder,
    name: &str,
) -> Result<Vec<usize>, LivePhotoError> {
    let count = usize::from(tiff_u16(data, offset, order)?);
    let start = offset
        .checked_add(2)
        .ok_or_else(|| maker_error(format!("{name} offset overflow")))?;
    let end = start
        .checked_add(
            count
                .checked_mul(12)
                .ok_or_else(|| maker_error(format!("{name} entry count overflow")))?,
        )
        .and_then(|end| end.checked_add(4))
        .ok_or_else(|| maker_error(format!("{name} table overflow")))?;
    if end > data.len() {
        return Err(maker_error(format!("{name} extends past TIFF payload")));
    }
    Ok((0..count).map(|index| start + index * 12).collect())
}

fn tiff_entry_value<'a>(
    data: &'a [u8],
    entry: usize,
    field_type: u16,
    count: u32,
    order: TiffOrder,
    name: &str,
) -> Result<&'a [u8], LivePhotoError> {
    let width = match field_type {
        1 | 2 | 6 | 7 => 1usize,
        3 | 8 => 2,
        4 | 9 | 11 | 13 => 4,
        5 | 10 | 12 | 16 | 17 | 18 => 8,
        _ => {
            return Err(maker_error(format!(
                "{name} uses unsupported TIFF type {field_type}"
            )))
        }
    };
    let length = usize::try_from(count)
        .ok()
        .and_then(|count| count.checked_mul(width))
        .ok_or_else(|| maker_error(format!("{name} length overflow")))?;
    let value_offset = if length <= 4 {
        entry
            .checked_add(8)
            .ok_or_else(|| maker_error(format!("{name} inline offset overflow")))?
    } else {
        usize::try_from(tiff_u32(data, entry + 8, order)?)
            .map_err(|_| maker_error(format!("{name} offset exceeds platform")))?
    };
    let end = value_offset
        .checked_add(length)
        .ok_or_else(|| maker_error(format!("{name} value overflow")))?;
    data.get(value_offset..end)
        .ok_or_else(|| maker_error(format!("{name} value is out of bounds")))
}

fn tiff_u16(data: &[u8], offset: usize, order: TiffOrder) -> Result<u16, LivePhotoError> {
    let bytes: [u8; 2] = data
        .get(offset..offset.saturating_add(2))
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| maker_error(format!("truncated TIFF u16 at {offset}")))?;
    Ok(match order {
        TiffOrder::Big => u16::from_be_bytes(bytes),
        TiffOrder::Little => u16::from_le_bytes(bytes),
    })
}

fn tiff_u32(data: &[u8], offset: usize, order: TiffOrder) -> Result<u32, LivePhotoError> {
    let bytes: [u8; 4] = data
        .get(offset..offset.saturating_add(4))
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| maker_error(format!("truncated TIFF u32 at {offset}")))?;
    Ok(match order {
        TiffOrder::Big => u32::from_be_bytes(bytes),
        TiffOrder::Little => u32::from_le_bytes(bytes),
    })
}

fn maker_error(reason: impl Into<String>) -> LivePhotoError {
    LivePhotoError::InvalidMakerNote {
        reason: reason.into(),
    }
}

fn checked_payload<'a>(
    data: &'a [u8],
    atom: Atom,
    context: &str,
) -> Result<&'a [u8], LivePhotoError> {
    if atom.start > data.len()
        || atom.payload_start() > data.len()
        || atom.end() > data.len()
        || atom.payload_start() > atom.end()
    {
        return Err(atom_error(
            context,
            atom.start,
            "atom payload is out of bounds",
        ));
    }
    Ok(&data[atom.payload_start()..atom.end()])
}

fn unique_child(atoms: &[Atom], kind: [u8; 4], path: &str) -> Result<Atom, LivePhotoError> {
    let matching: Vec<_> = atoms
        .iter()
        .copied()
        .filter(|atom| atom.kind == kind)
        .collect();
    if matching.len() == 1 {
        Ok(matching[0])
    } else {
        Err(LivePhotoError::UnsupportedMov {
            reason: format!("expected exactly one {path} atom, found {}", matching.len()),
        })
    }
}

fn read_u32_at(data: &[u8], offset: usize, context: &str) -> Result<u32, LivePhotoError> {
    let bytes: [u8; 4] = data
        .get(offset..offset.saturating_add(4))
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| atom_error(context, offset, "truncated u32"))?;
    Ok(u32::from_be_bytes(bytes))
}

fn read_u64_at(data: &[u8], offset: usize, context: &str) -> Result<u64, LivePhotoError> {
    let bytes: [u8; 8] = data
        .get(offset..offset.saturating_add(8))
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| atom_error(context, offset, "truncated u64"))?;
    Ok(u64::from_be_bytes(bytes))
}

fn read_u32_slice(data: &[u8], offset: usize, context: &str) -> Result<u32, LivePhotoError> {
    read_u32_at(data, offset, context)
}

fn read_u64_slice(data: &[u8], offset: usize, context: &str) -> Result<u64, LivePhotoError> {
    read_u64_at(data, offset, context)
}

fn read_i16_slice(data: &[u8], offset: usize, context: &str) -> Result<i16, LivePhotoError> {
    let bytes: [u8; 2] = data
        .get(offset..offset.saturating_add(2))
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| atom_error(context, offset, "truncated i16"))?;
    Ok(i16::from_be_bytes(bytes))
}

fn read_i32_slice(data: &[u8], offset: usize, context: &str) -> Result<i32, LivePhotoError> {
    let bytes: [u8; 4] = data
        .get(offset..offset.saturating_add(4))
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| atom_error(context, offset, "truncated i32"))?;
    Ok(i32::from_be_bytes(bytes))
}

fn be_u16(data: &[u8], offset: usize, context: &str) -> Result<u16, LivePhotoError> {
    let bytes: [u8; 2] = data
        .get(offset..offset.saturating_add(2))
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| maker_error(format!("truncated {context} u16 at {offset}")))?;
    Ok(u16::from_be_bytes(bytes))
}

fn be_u32(data: &[u8], offset: usize, context: &str) -> Result<u32, LivePhotoError> {
    let bytes: [u8; 4] = data
        .get(offset..offset.saturating_add(4))
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| maker_error(format!("truncated {context} u32 at {offset}")))?;
    Ok(u32::from_be_bytes(bytes))
}

fn push_u16(output: &mut Vec<u8>, value: u16) {
    output.extend_from_slice(&value.to_be_bytes());
}

fn push_i16(output: &mut Vec<u8>, value: i16) {
    output.extend_from_slice(&value.to_be_bytes());
}

fn push_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_be_bytes());
}

fn push_i32(output: &mut Vec<u8>, value: i32) {
    output.extend_from_slice(&value.to_be_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    const ASSET_ID: &str = "00112233-4455-6677-8899-AABBCCDDEEFF";
    const OTHER_ID: &str = "FFEEDDCC-BBAA-9988-7766-554433221100";

    // Minimal native-layout Apple MakerNote fixture. This is deliberately a
    // literal rather than output from `build_apple_maker_note`: it locks the
    // independently documented 14-byte signature and MakerNote-relative value
    // offset used by real iPhone files and recognized by ExifTool/Skia.
    const NATIVE_MINIMAL_MAKER_NOTE: &[u8] = &[
        0x41, 0x70, 0x70, 0x6c, 0x65, 0x20, 0x69, 0x4f, 0x53, 0x00, 0x00, 0x01, 0x4d, 0x4d, 0x00,
        0x01, 0x00, 0x11, 0x00, 0x02, 0x00, 0x00, 0x00, 0x25, 0x00, 0x00, 0x00, 0x20, 0x00, 0x00,
        0x00, 0x00, 0x30, 0x30, 0x31, 0x31, 0x32, 0x32, 0x33, 0x33, 0x2d, 0x34, 0x34, 0x35, 0x35,
        0x2d, 0x36, 0x36, 0x37, 0x37, 0x2d, 0x38, 0x38, 0x39, 0x39, 0x2d, 0x41, 0x41, 0x42, 0x42,
        0x43, 0x43, 0x44, 0x44, 0x45, 0x45, 0x46, 0x46, 0x00,
    ];

    #[test]
    fn uuid_contract_is_strict_uppercase_hyphenated() {
        assert!(validate_asset_identifier(ASSET_ID).is_ok());
        for invalid in [
            "00112233-4455-6677-8899-aabbccddeeff",
            "00112233445566778899AABBCCDDEEFF",
            "{00112233-4455-6677-8899-AABBCCDDEEFF}",
            "G0112233-4455-6677-8899-AABBCCDDEEFF",
        ] {
            assert!(matches!(
                validate_asset_identifier(invalid),
                Err(LivePhotoError::InvalidAssetIdentifier { .. })
            ));
        }
    }

    #[test]
    fn apple_maker_note_matches_native_layout_fixture() {
        assert_eq!(
            parse_apple_maker_note_asset_identifier(NATIVE_MINIMAL_MAKER_NOTE)
                .expect("parse native-layout fixture"),
            ASSET_ID
        );
        assert_eq!(
            build_apple_maker_note(ASSET_ID).expect("build MakerNote"),
            NATIVE_MINIMAL_MAKER_NOTE
        );
    }

    #[test]
    fn jpeg_round_trip_preserves_scan_bytes() {
        let jpeg = minimal_jpeg();
        let original_layout = parse_jpeg_layout(&jpeg).expect("parse source JPEG");
        let stamped = stamp_jpeg_bytes(&jpeg, ASSET_ID).expect("stamp JPEG");
        let stamped_layout = parse_jpeg_layout(&stamped).expect("parse stamped JPEG");

        assert_eq!(
            &jpeg[original_layout.scan_start..],
            &stamped[stamped_layout.scan_start..]
        );
        assert_eq!(
            extract_jpeg_asset_identifier(&stamped).expect("read MakerNote"),
            ASSET_ID
        );
    }

    #[test]
    fn existing_exif_is_rejected_instead_of_overwritten() {
        let stamped = stamp_jpeg_bytes(&minimal_jpeg(), ASSET_ID).expect("first stamp");
        assert!(matches!(
            stamp_jpeg_bytes(&stamped, ASSET_ID),
            Err(LivePhotoError::ExistingExif)
        ));
    }

    #[test]
    fn mov_parser_rejects_truncated_and_out_of_bounds_atoms() {
        let truncated = [0, 0, 0, 8, b'm', b'o', b'o'];
        assert!(matches!(
            parse_atom_sequence(&truncated, 0, truncated.len(), "fixture", true),
            Err(LivePhotoError::MalformedAtom { .. })
        ));

        let out_of_bounds = [0, 0, 0, 32, b'm', b'o', b'o', b'v'];
        assert!(matches!(
            parse_atom_sequence(&out_of_bounds, 0, out_of_bounds.len(), "fixture", true),
            Err(LivePhotoError::MalformedAtom { .. })
        ));
    }

    #[test]
    fn controlled_mov_finalize_and_pair_verify_close_contract() {
        let source_mov = minimal_controlled_mov(ASSET_ID);
        let source_layout = parse_movie_layout(&source_mov).expect("parse source MOV");
        let finalized = finalize_mov_bytes(&source_mov, ASSET_ID, 300).expect("finalize MOV");
        let jpeg = stamp_jpeg_bytes(&minimal_jpeg(), ASSET_ID).expect("stamp JPEG");
        let report = inspect_live_photo(Some(&jpeg), &finalized, ASSET_ID).expect("verify pair");

        assert_eq!(
            &finalized[..source_layout.moov.start],
            &source_mov[..source_layout.moov.start],
            "all original atoms and media bytes before moov must be byte-identical"
        );
        assert!(report.pair_verified);
        assert_eq!(report.asset_identifier, ASSET_ID);
        assert_eq!(report.still_time_movie_units, 300);
        assert_eq!(report.movie_timescale, 600);
        assert_eq!(report.video_track_id, 1);
        assert_eq!(report.metadata_track_id, 2);
        assert!(report.contract_is_closed());
        assert_eq!(report.jpeg_sha256.as_deref().map(str::len), Some(64));
        assert_eq!(report.mov_sha256.len(), 64);
        assert_eq!(report.contract_sha256.len(), 64);
    }

    #[test]
    fn wrong_id_time_and_fragmented_input_are_rejected() {
        let source = minimal_controlled_mov(ASSET_ID);
        assert!(matches!(
            finalize_mov_bytes(&source, OTHER_ID, 300),
            Err(LivePhotoError::ContentIdentifierMismatch { .. })
        ));
        assert!(matches!(
            finalize_mov_bytes(&source, ASSET_ID, 600),
            Err(LivePhotoError::InvalidStillTime { .. })
        ));

        let layout = parse_movie_layout(&source).expect("source layout");
        let moof = make_atom(*b"moof", &[]).expect("moof");
        let mut fragmented = Vec::new();
        fragmented.extend_from_slice(&source[..layout.moov.start]);
        fragmented.extend_from_slice(&moof);
        fragmented.extend_from_slice(&source[layout.moov.start..]);
        assert!(matches!(
            finalize_mov_bytes(&fragmented, ASSET_ID, 300),
            Err(LivePhotoError::FragmentedMov)
        ));
    }

    fn minimal_jpeg() -> Vec<u8> {
        vec![
            0xff, 0xd8, // SOI
            0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0
            0xff, 0xdb, 0x00, 0x03, 0x00, // tiny table segment
            0xff, 0xda, 0x00, 0x02, // SOS
            0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9, // scan + EOI
        ]
    }

    fn minimal_controlled_mov(asset_identifier: &str) -> Vec<u8> {
        let mut ftyp_payload = Vec::new();
        ftyp_payload.extend_from_slice(b"qt  ");
        push_u32(&mut ftyp_payload, 0);
        ftyp_payload.extend_from_slice(b"qt  ");
        let ftyp = make_atom(*b"ftyp", &ftyp_payload).expect("ftyp");
        let mdat = make_atom(*b"mdat", &[0xaa]).expect("video mdat");
        let video_sample_offset = (ftyp.len() + 8) as u32;

        let mvhd = test_mvhd(600, 600, 2);
        let video = test_video_track(1, 600, 600, video_sample_offset);
        let metadata = test_global_metadata(asset_identifier);
        let udta = make_atom(*b"udta", &metadata).expect("udta");
        let mut moov_payload = Vec::new();
        moov_payload.extend_from_slice(&mvhd);
        moov_payload.extend_from_slice(&video);
        moov_payload.extend_from_slice(&udta);
        let moov = make_atom(*b"moov", &moov_payload).expect("moov");

        let mut movie = Vec::new();
        movie.extend_from_slice(&ftyp);
        movie.extend_from_slice(&mdat);
        movie.extend_from_slice(&moov);
        movie
    }

    fn test_mvhd(timescale: u32, duration: u32, next_track_id: u32) -> Vec<u8> {
        let mut body = Vec::new();
        push_u32(&mut body, 0);
        push_u32(&mut body, 0);
        push_u32(&mut body, timescale);
        push_u32(&mut body, duration);
        push_u32(&mut body, 0x0001_0000);
        push_u16(&mut body, 0x0100);
        push_u16(&mut body, 0);
        body.extend_from_slice(&[0; 8]);
        for value in [0x0001_0000u32, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000] {
            push_u32(&mut body, value);
        }
        body.extend_from_slice(&[0; 24]);
        push_u32(&mut body, next_track_id);
        make_full_atom(*b"mvhd", 0, 0, &body).expect("mvhd")
    }

    fn test_video_track(
        track_id: u32,
        movie_duration: u32,
        media_timescale: u32,
        sample_offset: u32,
    ) -> Vec<u8> {
        let tkhd = build_tkhd(track_id, movie_duration).expect("video tkhd");
        let mut mdhd_body = Vec::new();
        push_u32(&mut mdhd_body, 0);
        push_u32(&mut mdhd_body, 0);
        push_u32(&mut mdhd_body, media_timescale);
        push_u32(&mut mdhd_body, movie_duration);
        push_u16(&mut mdhd_body, 0x55c4);
        push_u16(&mut mdhd_body, 0);
        let mdhd = make_full_atom(*b"mdhd", 0, 0, &mdhd_body).expect("video mdhd");

        let mut hdlr_body = Vec::new();
        push_u32(&mut hdlr_body, 0);
        hdlr_body.extend_from_slice(b"vide");
        hdlr_body.extend_from_slice(&[0; 12]);
        hdlr_body.extend_from_slice(b"Test Video\0");
        let hdlr = make_full_atom(*b"hdlr", 0, 0, &hdlr_body).expect("video hdlr");

        let mut stco_body = Vec::new();
        push_u32(&mut stco_body, 1);
        push_u32(&mut stco_body, sample_offset);
        let stco = make_full_atom(*b"stco", 0, 0, &stco_body).expect("video stco");
        let stbl = make_atom(*b"stbl", &stco).expect("video stbl");
        let minf = make_atom(*b"minf", &stbl).expect("video minf");
        let mut mdia_payload = Vec::new();
        mdia_payload.extend_from_slice(&mdhd);
        mdia_payload.extend_from_slice(&hdlr);
        mdia_payload.extend_from_slice(&minf);
        let mdia = make_atom(*b"mdia", &mdia_payload).expect("video mdia");
        let mut trak_payload = Vec::new();
        trak_payload.extend_from_slice(&tkhd);
        trak_payload.extend_from_slice(&mdia);
        make_atom(*b"trak", &trak_payload).expect("video trak")
    }

    fn test_global_metadata(asset_identifier: &str) -> Vec<u8> {
        let mut hdlr_body = Vec::new();
        push_u32(&mut hdlr_body, 0);
        hdlr_body.extend_from_slice(b"mdta");
        hdlr_body.extend_from_slice(&[0; 12]);
        hdlr_body.extend_from_slice(b"GIFP Metadata\0");
        let hdlr = make_full_atom(*b"hdlr", 0, 0, &hdlr_body).expect("meta hdlr");

        let mut keys_body = Vec::new();
        push_u32(&mut keys_body, 1);
        push_u32(
            &mut keys_body,
            u32::try_from(8 + CONTENT_IDENTIFIER_KEY.len()).expect("key size"),
        );
        keys_body.extend_from_slice(b"mdta");
        keys_body.extend_from_slice(CONTENT_IDENTIFIER_KEY.as_bytes());
        let keys = make_full_atom(*b"keys", 0, 0, &keys_body).expect("meta keys");

        let mut data_payload = Vec::new();
        push_u32(&mut data_payload, 1);
        push_u32(&mut data_payload, 0);
        data_payload.extend_from_slice(asset_identifier.as_bytes());
        let data = make_atom(*b"data", &data_payload).expect("meta data");
        let item = make_atom([0, 0, 0, 1], &data).expect("meta item");
        let ilst = make_atom(*b"ilst", &item).expect("meta ilst");

        let mut meta_body = Vec::new();
        meta_body.extend_from_slice(&hdlr);
        meta_body.extend_from_slice(&keys);
        meta_body.extend_from_slice(&ilst);
        make_full_atom(*b"meta", 0, 0, &meta_body).expect("meta")
    }
}
