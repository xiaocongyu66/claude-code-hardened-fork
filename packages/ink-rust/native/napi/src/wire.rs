//! v1: IRUI, version u8=1, kind u8 (1=batch,2=inspect), revision u32,
//! count u16; all integers little-endian. Inspect requires revision=0.
//! IDs: session u64, slot u32, generation u32. References: 0+ID or 1+temp u32.
//! Opcodes: 1=create box(temp,ref), 2=create text(temp,ref,text),
//! 3=update(ref,text), 4=reparent(ref,ref), 5=delete(ref).
//! Text: u32 byte length + strict UTF-8. No padding or trailing bytes.
use ink_rust_core as core;

pub const HEADER: usize = 12;
pub const MAX_OPS: usize = 256;
pub const MAX_TEXT: usize = 64 * 1024;
pub const MAX_TOTAL: usize = 256 * 1024;
// Largest fixed op is reparent: opcode + two tagged IDs = 35 bytes.
pub const MAX_BATCH: usize = HEADER + MAX_OPS * 35 + MAX_TOTAL;
pub const MAX_INSPECT: usize = HEADER + 4096 * 16;

#[derive(Debug, PartialEq)]
pub struct Error {
    pub code: &'static str,
    pub index: Option<u32>,
}
type Result<T> = std::result::Result<T, Error>;
#[derive(Debug)]
pub struct Id(u64, u32, u32);
impl Id {
    pub fn resolve(
        &self,
        session: &core::Session,
    ) -> std::result::Result<core::NodeId, core::Error> {
        session.node_id_from_parts(self.0, self.1 as usize, self.2)
    }
}
#[derive(Debug)]
pub enum Reference {
    Id(Id),
    Temp(u32),
}
impl Reference {
    fn resolve(&self, session: &core::Session) -> std::result::Result<core::NodeRef, core::Error> {
        match self {
            Self::Id(id) => id.resolve(session).map(core::NodeRef::Id),
            Self::Temp(t) => Ok(core::NodeRef::Temp(*t)),
        }
    }
}
#[derive(Debug)]
pub enum Op<'a> {
    Create(u32, Reference, Option<&'a str>),
    Update(Reference, &'a str),
    Reparent(Reference, Reference),
    Delete(Reference),
}
impl<'a> Op<'a> {
    pub fn resolve(
        &self,
        session: &core::Session,
    ) -> std::result::Result<core::Op<'a>, core::Error> {
        Ok(match self {
            Self::Create(temp, parent, text) => core::Op::Create {
                temp: *temp,
                parent: parent.resolve(session)?,
                kind: text.map_or(core::NodeSpec::Box, core::NodeSpec::Text),
            },
            Self::Update(node, text) => core::Op::UpdateText {
                node: node.resolve(session)?,
                text,
            },
            Self::Reparent(node, parent) => core::Op::Reparent {
                node: node.resolve(session)?,
                parent: parent.resolve(session)?,
            },
            Self::Delete(node) => core::Op::Delete {
                node: node.resolve(session)?,
            },
        })
    }
}
struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
    total: usize,
    index: Option<u32>,
}
impl<'a> Reader<'a> {
    fn error(&self, code: &'static str) -> Error {
        Error {
            code,
            index: self.index,
        }
    }
    fn take(&mut self, len: usize) -> Result<&'a [u8]> {
        let end = self
            .offset
            .checked_add(len)
            .ok_or_else(|| self.error("Input"))?;
        let bytes = self
            .bytes
            .get(self.offset..end)
            .ok_or_else(|| self.error("Input"))?;
        self.offset = end;
        Ok(bytes)
    }
    fn integer<const N: usize>(&mut self) -> Result<[u8; N]> {
        self.take(N)?.try_into().map_err(|_| self.error("Input"))
    }
    fn byte(&mut self) -> Result<u8> {
        Ok(self.integer::<1>()?[0])
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.integer()?))
    }
    fn id(&mut self) -> Result<Id> {
        Ok(Id(
            u64::from_le_bytes(self.integer()?),
            self.u32()?,
            self.u32()?,
        ))
    }
    fn reference(&mut self) -> Result<Reference> {
        match self.byte()? {
            0 => Ok(Reference::Id(self.id()?)),
            1 => Ok(Reference::Temp(self.u32()?)),
            _ => Err(self.error("Input")),
        }
    }
    fn text(&mut self) -> Result<&'a str> {
        let len = self.u32()? as usize;
        let total = self
            .total
            .checked_add(len)
            .ok_or_else(|| self.error("Limit"))?;
        if len > MAX_TEXT || total > MAX_TOTAL {
            return Err(self.error("Limit"));
        }
        self.total = total;
        std::str::from_utf8(self.take(len)?).map_err(|_| self.error("Utf8"))
    }
    fn finish(mut self) -> Result<()> {
        self.index = None;
        if self.offset != self.bytes.len() {
            return Err(self.error("Input"));
        }
        Ok(())
    }
}
fn header(
    bytes: &[u8],
    kind: u8,
    max: usize,
    count_max: usize,
) -> Result<(Reader<'_>, u32, usize)> {
    let mut r = Reader {
        bytes,
        offset: 0,
        total: 0,
        index: None,
    };
    if bytes.len() > max {
        return Err(r.error("Limit"));
    }
    if r.take(4)? != b"IRUI" || r.byte()? != 1 || r.byte()? != kind {
        return Err(r.error("Input"));
    }
    let revision = r.u32()?;
    let count = u16::from_le_bytes(r.integer()?) as usize;
    if count > count_max {
        return Err(r.error("Limit"));
    }
    Ok((r, revision, count))
}
pub fn batch(bytes: &[u8]) -> Result<(u32, Vec<Op<'_>>)> {
    let (mut r, revision, count) = header(bytes, 1, MAX_BATCH, MAX_OPS)?;
    let mut ops = Vec::with_capacity(count);
    for index in 0..count {
        r.index = Some(index as u32);
        ops.push(match r.byte()? {
            1 => Op::Create(r.u32()?, r.reference()?, None),
            2 => Op::Create(r.u32()?, r.reference()?, Some(r.text()?)),
            3 => Op::Update(r.reference()?, r.text()?),
            4 => Op::Reparent(r.reference()?, r.reference()?),
            5 => Op::Delete(r.reference()?),
            _ => return Err(r.error("Input")),
        });
    }
    r.finish()?;
    Ok((revision, ops))
}
pub fn inspect(bytes: &[u8]) -> Result<Vec<Id>> {
    let (mut r, revision, count) = header(bytes, 2, MAX_INSPECT, 4096)?;
    if revision != 0 {
        return Err(r.error("Input"));
    }
    let mut ids = Vec::with_capacity(count);
    for _ in 0..count {
        ids.push(r.id()?);
    }
    r.finish()?;
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn independent_vector_and_malformed_bytes() {
        // revision 0x12345678; create text temp 9, parent temp 7, UTF-8 é.
        let good = [
            73, 82, 85, 73, 1, 1, 120, 86, 52, 18, 1, 0, 2, 9, 0, 0, 0, 1, 7, 0, 0, 0, 2, 0, 0, 0,
            195, 169,
        ];
        let (revision, ops) = batch(&good).unwrap();
        assert_eq!(revision, 0x12345678);
        assert!(matches!(
            ops[0],
            Op::Create(9, Reference::Temp(7), Some("é"))
        ));
        for end in 0..good.len() {
            assert!(batch(&good[..end]).is_err());
        }
        for (offset, value, code, index) in [
            (4, 2, "Input", None),
            (12, 255, "Input", Some(0)),
            (26, 255, "Utf8", Some(0)),
            (25, 255, "Limit", Some(0)),
        ] {
            let mut bad = good;
            bad[offset] = value;
            assert_eq!(batch(&bad).unwrap_err(), Error { code, index });
        }
        let mut trailing = good.to_vec();
        trailing.push(0);
        assert_eq!(batch(&trailing).unwrap_err().index, None);
        assert_eq!(batch(&vec![0; MAX_BATCH + 1]).unwrap_err().code, "Limit");
        assert!(
            inspect(&[73, 82, 85, 73, 1, 2, 0, 0, 0, 0, 0, 0])
                .unwrap()
                .is_empty()
        );
        let wide = [
            73, 82, 85, 73, 1, 2, 0, 0, 0, 0, 1, 0, 255, 255, 255, 255, 255, 255, 255, 255, 120,
            86, 52, 18, 239, 205, 171, 144,
        ];
        let ids = inspect(&wide).unwrap();
        assert!(matches!(ids[0], Id(u64::MAX, 0x12345678, 0x90abcdef)));
    }
    #[test]
    fn limits() {
        let mut bytes = vec![73, 82, 85, 73, 1, 1, 0, 0, 0, 0, 0, 1];
        for i in 0..256 {
            if i < 4 {
                bytes.extend([3, 1, 0, 0, 0, 0]);
                bytes.extend((MAX_TEXT as u32).to_le_bytes());
                bytes.extend(vec![b'x'; MAX_TEXT]);
            } else {
                bytes.extend([5, 1, 0, 0, 0, 0]);
            }
        }
        assert_eq!(batch(&bytes).unwrap().1.len(), 256);
        // A fifth text exceeds only the cumulative text budget.
        let mut cumulative = vec![73, 82, 85, 73, 1, 1, 0, 0, 0, 0, 5, 0];
        for i in 0..5 {
            let len: u32 = if i < 4 { 65536 } else { 1 };
            cumulative.extend([3, 1, 0, 0, 0, 0]);
            cumulative.extend(len.to_le_bytes());
            cumulative.extend(vec![b'x'; len as usize]);
        }
        assert_eq!(
            batch(&cumulative).unwrap_err(),
            Error {
                code: "Limit",
                index: Some(4)
            }
        );
        assert_eq!(batch(&vec![0; MAX_BATCH]).unwrap_err().code, "Input");
        bytes[10..12].copy_from_slice(&257u16.to_le_bytes());
        assert_eq!(batch(&bytes).unwrap_err().code, "Limit");
        let mut ids = vec![73, 82, 85, 73, 1, 2, 0, 0, 0, 0, 0, 16];
        ids.resize(MAX_INSPECT, 0);
        assert_eq!(inspect(&ids).unwrap().len(), 4096);
        ids.push(0);
        assert_eq!(inspect(&ids).unwrap_err().code, "Limit");
    }
}
