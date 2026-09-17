//! Authenticated SRVSVC NetrShareEnum (MS-SRVS 3.1.4.8), NDR32 over DCE/RPC.
//! No filesystem paths, credentials, or shares outside the session ACL are exposed.
use std::collections::{HashSet, VecDeque};

const SRVSVC: [u8; 20] = [
    0xc8, 0x4f, 0x32, 0x4b, 0x70, 0x16, 0xd3, 0x01, 0x12, 0x78, 0x5a, 0x47, 0xbf, 0x6e, 0xe1, 0x88,
    3, 0, 0, 0,
];
const NDR32: [u8; 20] = [
    4, 0x5d, 0x88, 0x8a, 0xeb, 0x1c, 0xc9, 0x11, 0x9f, 0xe8, 8, 0, 0x2b, 0x10, 0x48, 0x60, 2, 0, 0,
    0,
];
const LIMIT: usize = 262144;

pub(crate) struct Pipe {
    names: Vec<String>,
    input: Vec<u8>,
    output: VecDeque<Vec<u8>>,
    message_remaining: usize,
    contexts: HashSet<u16>,
    fragment_size: usize,
}

impl Pipe {
    pub fn new(mut names: Vec<String>) -> Self {
        names.sort();
        Self {
            names,
            input: Vec::new(),
            output: VecDeque::new(),
            contexts: HashSet::new(),
            message_remaining: 0,
            fragment_size: 4280,
        }
    }

    pub fn pending(&self) -> usize {
        self.output.iter().map(Vec::len).sum()
    }
    pub fn remaining(&self) -> usize {
        self.message_remaining
    }
    pub fn read(&mut self, max: usize) -> Vec<u8> {
        let Some(message) = self.output.front_mut() else {
            self.message_remaining = 0;
            return vec![];
        };
        let data = message.drain(..max.min(message.len())).collect();
        self.message_remaining = message.len();
        if message.is_empty() {
            self.output.pop_front();
        }
        data
    }

    pub fn write(&mut self, data: &[u8]) -> Result<(), ()> {
        if self.input.len() + data.len() > LIMIT {
            return Err(());
        }
        self.input.extend_from_slice(data);
        while self.input.len() >= 16 {
            let size = u16::from_le_bytes([self.input[8], self.input[9]]) as usize;
            if size < 16
                || self.input[..2] != [5, 0]
                || self.input[4..8] != [0x10, 0, 0, 0]
                || self.input[10..12] != [0, 0]
            {
                return Err(());
            }
            if self.input.len() < size {
                break;
            }
            let packet: Vec<u8> = self.input.drain(..size).collect();
            let call = u32::from_le_bytes(packet[12..16].try_into().unwrap());
            // Share enumeration requests fit in one RPC fragment. Never interpret
            // a partial/fragmented request as a complete NDR structure.
            if packet[3] & 3 != 3 {
                return Err(());
            }
            match packet[2] {
                11 | 14 => {
                    let mut r = Reader {
                        bytes: &packet[16..],
                        pos: 0,
                    };
                    let _transmit = r.u16()?;
                    let receive = r.u16()? as usize;
                    if receive < 128 {
                        return Err(());
                    }
                    self.fragment_size = receive.min(4280);
                    r.u32()?;
                    let count = r.take(4)?[0] as usize;
                    if count == 0 {
                        return Err(());
                    }
                    let mut results = Vec::new();
                    for _ in 0..count {
                        let id = r.u16()?;
                        let transfers = r.take(2)?[0] as usize;
                        let abstract_syntax = r.take(20)?;
                        let mut accepted = false;
                        for _ in 0..transfers {
                            if r.take(20)? == NDR32 && abstract_syntax == SRVSVC {
                                accepted = true;
                            }
                        }
                        if accepted {
                            self.contexts.insert(id);
                        } else {
                            self.contexts.remove(&id);
                        }
                        results
                            .extend_from_slice(&(if accepted { 0u16 } else { 2u16 }).to_le_bytes());
                        results.extend_from_slice(
                            &(if accepted {
                                0u16
                            } else if abstract_syntax != SRVSVC {
                                1u16
                            } else {
                                2u16
                            })
                            .to_le_bytes(),
                        );
                        results.extend_from_slice(if accepted { &NDR32 } else { &[0; 20] });
                    }
                    if r.pos != r.bytes.len() {
                        return Err(());
                    }
                    let mut body = Vec::new();
                    body.extend_from_slice(&(4280u16).to_le_bytes());
                    body.extend_from_slice(&(self.fragment_size as u16).to_le_bytes());
                    body.extend_from_slice(&1u32.to_le_bytes());
                    let address: &[u8] = if packet[2] == 11 {
                        b"\\PIPE\\srvsvc\0"
                    } else {
                        b""
                    };
                    body.extend_from_slice(&(address.len() as u16).to_le_bytes());
                    body.extend_from_slice(address);
                    while body.len() % 4 != 0 {
                        body.push(0);
                    }
                    body.extend_from_slice(&[count as u8, 0, 0, 0]);
                    body.extend_from_slice(&results);
                    self.emit(if packet[2] == 11 { 12 } else { 15 }, 3, call, &body)?;
                }
                0 => {
                    let mut r = Reader {
                        bytes: &packet[16..],
                        pos: 0,
                    };
                    r.u32()?;
                    let context = r.u16()?;
                    let opnum = r.u16()?;
                    let response = if !self.contexts.contains(&context) {
                        Err(0x1c00001c_u32) // nca_s_fault_context_mismatch
                    } else if opnum != 15 {
                        Err(0x1c010002_u32) // nca_s_op_rng_error
                    } else {
                        self.enumerate(&packet[24..]).map_err(|_| 0x1c000006_u32)
                    };
                    match response {
                        Ok(stub) => {
                            let size = self.fragment_size - 24;
                            let chunks = stub.chunks(size);
                            let count = chunks.len();
                            for (i, chunk) in chunks.enumerate() {
                                let mut body = Vec::new();
                                body.extend_from_slice(
                                    &((stub.len() - i * size) as u32).to_le_bytes(),
                                );
                                body.extend_from_slice(&context.to_le_bytes());
                                body.extend_from_slice(&[0, 0]);
                                body.extend_from_slice(chunk);
                                self.emit(
                                    2,
                                    u8::from(i == 0) | (u8::from(i + 1 == count) << 1),
                                    call,
                                    &body,
                                )?;
                            }
                        }
                        Err(status) => {
                            let mut body = vec![0; 16];
                            body[4..6].copy_from_slice(&context.to_le_bytes());
                            body[8..12].copy_from_slice(&status.to_le_bytes());
                            self.emit(3, 3, call, &body)?;
                        }
                    }
                }
                _ => return Err(()),
            }
        }
        Ok(())
    }

    fn emit(&mut self, kind: u8, flags: u8, call: u32, body: &[u8]) -> Result<(), ()> {
        let size = 16 + body.len();
        if size > u16::MAX as usize || self.pending() + size > LIMIT {
            return Err(());
        }
        let mut packet = vec![5, 0, kind, flags, 0x10, 0, 0, 0];
        packet.extend((size as u16).to_le_bytes());
        packet.extend([0, 0]);
        packet.extend(call.to_le_bytes());
        packet.extend(body);
        self.output.push_back(packet);
        Ok(())
    }

    fn enumerate(&self, stub: &[u8]) -> Result<Vec<u8>, ()> {
        let mut r = Reader {
            bytes: stub,
            pos: 0,
        };
        if r.u32()? != 0 {
            r.string()?;
        }
        let level = r.u32()?;
        if r.u32()? != level {
            return Err(());
        }
        let container = r.u32()?;
        if container != 0 {
            // The caller supplies an empty output container, not an input array.
            if r.u32()? != 0 || r.u32()? != 0 {
                return Err(());
            }
        }
        let preferred = r.u32()? as usize;
        let resume_ptr = r.u32()?;
        let resume = if resume_ptr != 0 {
            r.u32()? as usize
        } else {
            0
        };
        if r.pos != stub.len() {
            return Err(());
        }
        let mut out = Vec::new();
        out.extend_from_slice(&level.to_le_bytes());
        out.extend_from_slice(&level.to_le_bytes());
        if level > 1 || resume > self.names.len() {
            out.extend_from_slice(&0u32.to_le_bytes());
            out.extend_from_slice(&0u32.to_le_bytes());
            out.extend_from_slice(&resume_ptr.to_le_bytes());
            if resume_ptr != 0 {
                out.extend_from_slice(&0u32.to_le_bytes());
            }
            out.extend_from_slice(&(if level > 1 { 124u32 } else { 87u32 }).to_le_bytes());
            return Ok(out);
        }
        // Bound each page even when the caller requests MAX_PREFERRED_LENGTH.
        let budget = preferred.min(65536);
        let mut end = resume;
        let mut used = 32usize;
        while end < self.names.len() {
            let bytes = (self.names[end].encode_utf16().count() + 1) * 2;
            let cost = (if level == 1 { 40 } else { 16 }) + (bytes + 3) / 4 * 4;
            if used + cost > budget {
                break;
            }
            used += cost;
            end += 1;
        }
        let count = (end - resume) as u32;
        out.extend_from_slice(&0x20000u32.to_le_bytes());
        out.extend_from_slice(&count.to_le_bytes());
        out.extend_from_slice(&(if count == 0 { 0u32 } else { 0x20004u32 }).to_le_bytes());
        if count != 0 {
            out.extend_from_slice(&count.to_le_bytes());
            for i in 0..count {
                out.extend_from_slice(&(0x20008 + i * 8).to_le_bytes());
                if level == 1 {
                    out.extend_from_slice(&0u32.to_le_bytes()); // STYPE_DISKTREE
                    out.extend_from_slice(&(0x2000c + i * 8).to_le_bytes());
                }
            }
            for name in &self.names[resume..end] {
                for value in std::iter::once(name.as_str()).chain((level == 1).then_some("")) {
                    let units: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
                    out.extend_from_slice(&(units.len() as u32).to_le_bytes());
                    out.extend_from_slice(&0u32.to_le_bytes());
                    out.extend_from_slice(&(units.len() as u32).to_le_bytes());
                    for unit in units {
                        out.extend_from_slice(&unit.to_le_bytes());
                    }
                    while out.len() % 4 != 0 {
                        out.push(0);
                    }
                }
            }
        }
        out.extend_from_slice(&(self.names.len() as u32).to_le_bytes());
        out.extend_from_slice(&resume_ptr.to_le_bytes());
        if resume_ptr != 0 {
            out.extend_from_slice(
                &(if end < self.names.len() {
                    end as u32
                } else {
                    0
                })
                .to_le_bytes(),
            );
        }
        out.extend_from_slice(&(if end < self.names.len() { 234u32 } else { 0 }).to_le_bytes());
        Ok(out)
    }
}

// Checked NDR cursor: lengths are untrusted; alignment is relative to the stub.
struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}
impl<'a> Reader<'a> {
    fn take(&mut self, size: usize) -> Result<&'a [u8], ()> {
        let end = self.pos.checked_add(size).ok_or(())?;
        let value = self.bytes.get(self.pos..end).ok_or(())?;
        self.pos = end;
        Ok(value)
    }
    fn u16(&mut self) -> Result<u16, ()> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<u32, ()> {
        self.pos = (self.pos + 3) & !3;
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn string(&mut self) -> Result<(), ()> {
        let max = self.u32()? as usize;
        let offset = self.u32()? as usize;
        let count = self.u32()? as usize;
        if offset != 0 || count == 0 || count > max || max > 32768 {
            return Err(());
        }
        let text = self.take(count.checked_mul(2).ok_or(())?)?;
        if text[text.len() - 2..] != [0, 0] {
            return Err(());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BIND: &str = "05000b03100000004800000001000000b810b810000000000100000000000100c84f324b7016d30112785a47bf6ee18803000000045d888aeb1cc9119fe808002b10486002000000";
    const ENUM: &str = "050000031000000060000000010000004800000000000f00de6c00000c000000000000000c0000005c005c003100320037002e0030002e0030002e00310000000100000001000000cfc000000000000000000000ffffffffd4b0000000000000";

    #[test]
    fn captured_client_requests_accept_split_writes_and_short_reads() {
        let bind: Vec<u8> = BIND
            .as_bytes()
            .chunks(2)
            .map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).unwrap())
            .collect();
        let request: Vec<u8> = ENUM
            .as_bytes()
            .chunks(2)
            .map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).unwrap())
            .collect();
        let mut pipe = Pipe::new(vec!["Test".into(), "Café".into()]);
        for byte in bind {
            pipe.write(&[byte]).unwrap();
        }
        let ack = pipe.read(usize::MAX);
        assert_eq!(ack[2], 12);
        assert_eq!(pipe.remaining(), 0);
        assert_eq!(&ack[48..], &NDR32);
        pipe.write(&request).unwrap();
        let mut response = vec![];
        while pipe.pending() != 0 {
            response.extend(pipe.read(7));
        }
        assert_eq!(response[2], 2);
        assert_eq!(u32::from_le_bytes(response[36..40].try_into().unwrap()), 2);
        assert_eq!(&response[response.len() - 4..], &[0; 4]);
    }

    #[test]
    fn truncated_or_malformed_ndr_never_panics() {
        let request: Vec<u8> = ENUM
            .as_bytes()
            .chunks(2)
            .map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).unwrap())
            .collect();
        let pipe = Pipe::new(vec!["Test".into()]);
        for length in 0..request.len() - 24 {
            assert!(pipe.enumerate(&request[24..24 + length]).is_err());
        }
        let mut stub = request[24..].to_vec();
        stub[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(pipe.enumerate(&stub).is_err());
    }

    #[test]
    fn invalid_headers_and_excessive_buffers_are_rejected() {
        for header in [[0; 16], [255; 16]] {
            assert!(Pipe::new(vec![]).write(&header).is_err());
        }
        assert!(Pipe::new(vec![]).write(&vec![0; LIMIT + 1]).is_err());
        let mut bind: Vec<u8> = BIND
            .as_bytes()
            .chunks(2)
            .map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).unwrap())
            .collect();
        bind[3] = 1;
        assert!(Pipe::new(vec![]).write(&bind).is_err());
    }

    #[test]
    fn rejected_interface_and_unbound_calls_do_not_enumerate() {
        let mut bind: Vec<u8> = BIND
            .as_bytes()
            .chunks(2)
            .map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).unwrap())
            .collect();
        let request: Vec<u8> = ENUM
            .as_bytes()
            .chunks(2)
            .map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).unwrap())
            .collect();
        bind[32] ^= 255;
        let mut pipe = Pipe::new(vec!["Secret".into()]);
        pipe.write(&bind).unwrap();
        let ack = pipe.read(usize::MAX);
        assert_eq!(&ack[44..48], &[2, 0, 1, 0]);
        pipe.write(&request).unwrap();
        assert_eq!(pipe.read(usize::MAX)[2], 3);
    }

    #[test]
    fn pagination_empty_lists_invalid_levels_and_resume_handles() {
        let request: Vec<u8> = ENUM
            .as_bytes()
            .chunks(2)
            .map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).unwrap())
            .collect();
        let mut stub = request[24..].to_vec();
        let pipe = Pipe::new(vec!["First".into(), "Second".into()]);
        stub[60..64].copy_from_slice(&90u32.to_le_bytes());
        let first = pipe.enumerate(&stub).unwrap();
        assert_eq!(u32::from_le_bytes(first[12..16].try_into().unwrap()), 1);
        assert_eq!(&first[first.len() - 8..], &[1, 0, 0, 0, 234, 0, 0, 0]);
        stub[68..72].copy_from_slice(&1u32.to_le_bytes());
        let last = pipe.enumerate(&stub).unwrap();
        assert_eq!(&last[last.len() - 8..], &[0; 8]);
        stub[68..72].copy_from_slice(&999u32.to_le_bytes());
        let invalid = pipe.enumerate(&stub).unwrap();
        assert_eq!(&invalid[invalid.len() - 4..], &87u32.to_le_bytes());
        stub[68..72].fill(0);
        let empty = Pipe::new(vec![]).enumerate(&stub).unwrap();
        assert_eq!(&empty[12..24], &[0; 12]);
        stub[40..44].copy_from_slice(&2u32.to_le_bytes());
        stub[44..48].copy_from_slice(&2u32.to_le_bytes());
        let unsupported = pipe.enumerate(&stub).unwrap();
        assert_eq!(&unsupported[unsupported.len() - 4..], &124u32.to_le_bytes());
    }

    #[test]
    fn large_enumerations_fragment_with_matching_call_and_context() {
        let bind: Vec<u8> = BIND
            .as_bytes()
            .chunks(2)
            .map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).unwrap())
            .collect();
        let request: Vec<u8> = ENUM
            .as_bytes()
            .chunks(2)
            .map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).unwrap())
            .collect();
        let mut pipe = Pipe::new((0..250).map(|i| format!("Share-{i:04}")).collect());
        pipe.write(&bind).unwrap();
        pipe.read(usize::MAX);
        pipe.write(&request).unwrap();
        let mut response = vec![];
        while pipe.pending() != 0 {
            response.extend(pipe.read(usize::MAX));
        }
        let mut pos = 0;
        let mut fragments = 0;
        while pos < response.len() {
            let size = u16::from_le_bytes(response[pos + 8..pos + 10].try_into().unwrap()) as usize;
            assert!(size <= 4280);
            assert_eq!(&response[pos + 12..pos + 16], &1u32.to_le_bytes());
            assert_eq!(response[pos + 3] & 1, u8::from(pos == 0));
            assert_eq!(
                response[pos + 3] & 2,
                u8::from(pos + size == response.len()) * 2
            );
            pos += size;
            fragments += 1;
        }
        assert!(fragments > 1);
    }
}
