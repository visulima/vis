//! Bounds-checked reader for the import table of a mapped PE32+ image.
//!
//! The IAT patcher in `hooks.rs` used to chase raw pointers derived from RVAs it
//! had read out of the module, with no limits. Parsing a byte slice of the
//! mapped image instead means a malformed or unusual module yields "no imports"
//! rather than an access violation inside `DllMain`, and the layout logic can be
//! unit-tested with synthetic headers on any host.
//!
//! Offsets are the documented PE32+ (`IMAGE_NT_HEADERS64`) layout; everything is
//! little-endian.

const DOS_MAGIC: u16 = 0x5a4d; // "MZ"
const NT_SIGNATURE: u32 = 0x0000_4550; // "PE\0\0"
const OPTIONAL_MAGIC_PE32_PLUS: u16 = 0x20b;

const E_LFANEW: usize = 0x3c;
/// `IMAGE_NT_HEADERS64`: signature (4) + `IMAGE_FILE_HEADER` (20) precede the optional header.
const OPTIONAL_HEADER: usize = 24;
const SIZE_OF_IMAGE: usize = OPTIONAL_HEADER + 56;
const NUMBER_OF_RVA_AND_SIZES: usize = OPTIONAL_HEADER + 108;
const DATA_DIRECTORY: usize = OPTIONAL_HEADER + 112;
const IMPORT_DIRECTORY: usize = 1;
const DATA_DIRECTORY_ENTRY: usize = 8;

const IMPORT_DESCRIPTOR_SIZE: usize = 20;
const THUNK_SIZE: usize = 8;
const ORDINAL_FLAG: u64 = 1 << 63;

/// An import that is bound by name, with the offset (from the image base) of the
/// 8-byte IAT slot that receives its address.
#[derive(Debug, PartialEq, Eq)]
pub struct NamedImport<'a> {
    pub name: &'a [u8],
    pub iat_offset: usize,
}

fn u16_at(image: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(image.get(at..at.checked_add(2)?)?.try_into().ok()?))
}

fn u32_at(image: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(image.get(at..at.checked_add(4)?)?.try_into().ok()?))
}

fn u64_at(image: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_le_bytes(image.get(at..at.checked_add(8)?)?.try_into().ok()?))
}

/// Offset of the NT headers, after checking the DOS and NT signatures and that
/// the optional header is the 64-bit kind.
fn nt_headers(image: &[u8]) -> Option<usize> {
    if u16_at(image, 0)? != DOS_MAGIC {
        return None;
    }

    let nt = usize::try_from(u32_at(image, E_LFANEW)?).ok()?;

    if u32_at(image, nt)? != NT_SIGNATURE
        || u16_at(image, nt.checked_add(OPTIONAL_HEADER)?)? != OPTIONAL_MAGIC_PE32_PLUS
    {
        return None;
    }

    Some(nt)
}

/// `SizeOfImage` from the headers, given at least the first page of the module.
pub fn image_size(headers: &[u8]) -> Option<usize> {
    let nt = nt_headers(headers)?;

    usize::try_from(u32_at(headers, nt.checked_add(SIZE_OF_IMAGE)?)?).ok()
}

/// NUL-terminated name of an `IMAGE_IMPORT_BY_NAME` at `rva` (skipping its
/// 2-byte hint). `None` when it runs off the image without a terminator.
fn import_name(image: &[u8], rva: usize) -> Option<&[u8]> {
    let tail = image.get(rva.checked_add(2)?..)?;
    let end = tail.iter().position(|&b| b == 0)?;

    Some(&tail[..end])
}

/// Every by-name import in the module's import table, in table order.
///
/// A descriptor without an import name table (`OriginalFirstThunk == 0`) is
/// skipped: in a loaded module its IAT already holds bound absolute addresses,
/// not RVAs of names, so reading names from it would chase wild pointers.
pub fn named_imports(image: &[u8]) -> Vec<NamedImport<'_>> {
    let mut out = Vec::new();

    let Some(nt) = nt_headers(image) else {
        return out;
    };

    let imports = (|| {
        let count = u32_at(image, nt.checked_add(NUMBER_OF_RVA_AND_SIZES)?)?;

        if count as usize <= IMPORT_DIRECTORY {
            return None;
        }

        let entry = nt.checked_add(DATA_DIRECTORY)?.checked_add(IMPORT_DIRECTORY * DATA_DIRECTORY_ENTRY)?;

        usize::try_from(u32_at(image, entry)?).ok().filter(|&rva| rva != 0)
    })();

    let Some(mut descriptor) = imports else {
        return out;
    };

    // `Name` (offset 12) of zero terminates the descriptor array.
    while let Some(name_rva) = descriptor.checked_add(12).and_then(|at| u32_at(image, at)) {
        if name_rva == 0 {
            break;
        }

        let original_first_thunk = u32_at(image, descriptor).unwrap_or(0);
        let first_thunk = descriptor.checked_add(16).and_then(|at| u32_at(image, at)).unwrap_or(0);

        collect_thunks(image, original_first_thunk as usize, first_thunk as usize, &mut out);

        let Some(next) = descriptor.checked_add(IMPORT_DESCRIPTOR_SIZE) else {
            break;
        };
        descriptor = next;
    }

    out
}

fn collect_thunks<'a>(image: &'a [u8], names_rva: usize, iat_rva: usize, out: &mut Vec<NamedImport<'a>>) {
    if names_rva == 0 || iat_rva == 0 {
        return;
    }

    for index in 0usize.. {
        let Some(offset) = index.checked_mul(THUNK_SIZE) else {
            return;
        };
        let Some(entry) = names_rva.checked_add(offset).and_then(|at| u64_at(image, at)) else {
            return;
        };

        if entry == 0 {
            return;
        }

        // Imports by ordinal carry no name to match.
        if entry & ORDINAL_FLAG != 0 {
            continue;
        }

        let Some(name) = usize::try_from(entry).ok().and_then(|rva| import_name(image, rva)) else {
            continue;
        };
        let Some(iat_offset) = iat_rva.checked_add(offset) else {
            return;
        };

        // The slot must lie inside the image for the caller to patch it.
        if iat_offset.checked_add(THUNK_SIZE).is_some_and(|end| end <= image.len()) {
            out.push(NamedImport { name, iat_offset });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INT: usize = 0x400;
    const IAT: usize = 0x500;
    const NAMES: usize = 0x600;
    const IMPORT_TABLE: usize = 0x300;
    const SIZE: usize = 0x1000;

    /// A minimal mapped PE32+ image: one import descriptor (`INT`/`IAT` slots as
    /// given) followed by the NUL descriptor terminator.
    struct Image(Vec<u8>);

    impl Image {
        fn new() -> Self {
            let mut b = vec![0u8; SIZE];
            let nt = 0x80usize;

            b[0..2].copy_from_slice(&DOS_MAGIC.to_le_bytes());
            b[E_LFANEW..E_LFANEW + 4].copy_from_slice(&(nt as u32).to_le_bytes());
            b[nt..nt + 4].copy_from_slice(&NT_SIGNATURE.to_le_bytes());
            b[nt + OPTIONAL_HEADER..nt + OPTIONAL_HEADER + 2].copy_from_slice(&OPTIONAL_MAGIC_PE32_PLUS.to_le_bytes());
            b[nt + SIZE_OF_IMAGE..nt + SIZE_OF_IMAGE + 4].copy_from_slice(&(SIZE as u32).to_le_bytes());
            b[nt + NUMBER_OF_RVA_AND_SIZES..nt + NUMBER_OF_RVA_AND_SIZES + 4].copy_from_slice(&16u32.to_le_bytes());

            let dir = nt + DATA_DIRECTORY + IMPORT_DIRECTORY * DATA_DIRECTORY_ENTRY;
            b[dir..dir + 4].copy_from_slice(&(IMPORT_TABLE as u32).to_le_bytes());

            Self(b)
        }

        fn put(&mut self, at: usize, bytes: &[u8]) {
            self.0[at..at + bytes.len()].copy_from_slice(bytes);
        }

        fn descriptor(&mut self, n: usize, oft: u32, name: u32, ft: u32) {
            let at = IMPORT_TABLE + n * IMPORT_DESCRIPTOR_SIZE;
            self.put(at, &oft.to_le_bytes());
            self.put(at + 12, &name.to_le_bytes());
            self.put(at + 16, &ft.to_le_bytes());
        }

        /// Write an `IMAGE_IMPORT_BY_NAME` at `at` and return its RVA.
        fn by_name(&mut self, at: usize, name: &str) -> u64 {
            self.put(at + 2, name.as_bytes());
            at as u64
        }

        fn thunk(&mut self, table: usize, index: usize, value: u64) {
            self.put(table + index * THUNK_SIZE, &value.to_le_bytes());
        }
    }

    fn names<'a>(found: &[NamedImport<'a>]) -> Vec<(&'a str, usize)> {
        found.iter().map(|i| (std::str::from_utf8(i.name).unwrap(), i.iat_offset)).collect()
    }

    #[test]
    fn reports_named_imports_with_their_slot_offsets() {
        let mut img = Image::new();
        img.descriptor(0, INT as u32, 0x700, IAT as u32);
        let a = img.by_name(NAMES, "CreateFileW");
        let c = img.by_name(NAMES + 0x40, "DeleteFileW");
        img.thunk(INT, 0, a);
        img.thunk(INT, 1, ORDINAL_FLAG | 7);
        img.thunk(INT, 2, c);

        let found = named_imports(&img.0);

        assert_eq!(names(&found), vec![("CreateFileW", IAT), ("DeleteFileW", IAT + 2 * THUNK_SIZE)]);
    }

    #[test]
    fn walks_every_descriptor() {
        let mut img = Image::new();
        img.descriptor(0, INT as u32, 0x700, IAT as u32);
        img.descriptor(1, (INT + 0x100) as u32, 0x710, (IAT + 0x100) as u32);
        let a = img.by_name(NAMES, "CreateFileW");
        let b = img.by_name(NAMES + 0x40, "MoveFileExW");
        img.thunk(INT, 0, a);
        img.thunk(INT + 0x100, 0, b);

        let found = named_imports(&img.0);

        assert_eq!(names(&found), vec![("CreateFileW", IAT), ("MoveFileExW", IAT + 0x100)]);
    }

    // A loaded module with no import name table has an IAT of absolute addresses.
    // Treating those as name RVAs must not produce imports, even when a value
    // happens to land on a valid-looking name.
    #[test]
    fn skips_descriptors_without_an_import_name_table() {
        let mut img = Image::new();
        img.descriptor(0, 0, 0x700, IAT as u32);
        let a = img.by_name(NAMES, "CreateFileW");
        img.thunk(IAT, 0, a);
        img.thunk(IAT, 1, 0x7ff8_1234_5678);

        assert!(named_imports(&img.0).is_empty());
    }

    #[test]
    fn a_name_table_without_an_iat_is_skipped() {
        let mut img = Image::new();
        img.descriptor(0, INT as u32, 0x700, 0);
        let a = img.by_name(NAMES, "CreateFileW");
        img.thunk(INT, 0, a);

        assert!(named_imports(&img.0).is_empty());
    }

    #[test]
    fn out_of_range_name_rvas_are_ignored_not_followed() {
        let mut img = Image::new();
        img.descriptor(0, INT as u32, 0x700, IAT as u32);
        let a = img.by_name(NAMES, "CreateFileW");
        img.thunk(INT, 0, 0x7ff8_1234_5678);
        img.thunk(INT, 1, (SIZE as u64) - 1);
        img.thunk(INT, 2, u64::MAX >> 1);
        img.thunk(INT, 3, a);

        let found = named_imports(&img.0);

        assert_eq!(names(&found), vec![("CreateFileW", IAT + 3 * THUNK_SIZE)]);
    }

    #[test]
    fn a_name_without_a_terminator_is_ignored() {
        let mut img = Image::new();
        img.descriptor(0, INT as u32, 0x700, IAT as u32);
        for b in &mut img.0[SIZE - 8..] {
            *b = b'A';
        }
        img.thunk(INT, 0, (SIZE - 8) as u64);

        assert!(named_imports(&img.0).is_empty());
    }

    #[test]
    fn an_unterminated_name_table_stops_at_the_image_end() {
        let mut img = Image::new();
        img.descriptor(0, (SIZE - 16) as u32, 0x700, IAT as u32);
        img.thunk(SIZE - 16, 0, ORDINAL_FLAG | 1);
        img.thunk(SIZE - 16, 1, ORDINAL_FLAG | 2);

        assert!(named_imports(&img.0).is_empty());
    }

    #[test]
    fn iat_slots_outside_the_image_are_not_reported() {
        let mut img = Image::new();
        img.descriptor(0, INT as u32, 0x700, (SIZE - 4) as u32);
        let a = img.by_name(NAMES, "CreateFileW");
        img.thunk(INT, 0, a);

        assert!(named_imports(&img.0).is_empty());
    }

    #[test]
    fn rejects_images_that_are_not_pe32_plus() {
        let mut img = Image::new();
        img.descriptor(0, INT as u32, 0x700, IAT as u32);
        let a = img.by_name(NAMES, "CreateFileW");
        img.thunk(INT, 0, a);
        assert_eq!(named_imports(&img.0).len(), 1);

        let mut no_mz = Image::new();
        no_mz.0[0] = 0;
        assert!(named_imports(&no_mz.0).is_empty());

        let mut pe32 = Image::new();
        pe32.put(0x80 + OPTIONAL_HEADER, &0x10bu16.to_le_bytes());
        assert!(named_imports(&pe32.0).is_empty());

        let mut bad_nt = Image::new();
        bad_nt.put(0x80, b"XX");
        assert!(named_imports(&bad_nt.0).is_empty());

        let mut far_nt = Image::new();
        far_nt.put(E_LFANEW, &u32::MAX.to_le_bytes());
        assert!(named_imports(&far_nt.0).is_empty());
    }

    #[test]
    fn modules_without_an_import_directory_yield_nothing() {
        let mut none = Image::new();
        none.put(0x80 + DATA_DIRECTORY + DATA_DIRECTORY_ENTRY, &0u32.to_le_bytes());
        assert!(named_imports(&none.0).is_empty());

        let mut few = Image::new();
        few.put(0x80 + NUMBER_OF_RVA_AND_SIZES, &1u32.to_le_bytes());
        assert!(named_imports(&few.0).is_empty());
    }

    #[test]
    fn truncated_and_empty_images_are_safe() {
        assert!(named_imports(&[]).is_empty());
        assert!(named_imports(b"MZ").is_empty());

        let img = Image::new();
        for len in 0..SIZE {
            let _ = named_imports(&img.0[..len]);
        }
    }

    #[test]
    fn image_size_reads_size_of_image_from_the_headers() {
        let img = Image::new();

        assert_eq!(image_size(&img.0[..0x100]), Some(SIZE));
        assert_eq!(image_size(&img.0[..0x40]), None);
        assert_eq!(image_size(b"not a pe"), None);
    }
}
