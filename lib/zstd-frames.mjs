// Split a concatenated zstd frame stream (as DSH's append-only session logs
// write) into per-frame byte ranges, so each slice can go through Node's
// single-frame zstdDecompressSync. Frame layout follows RFC 8878:
// magic(4) FHD(1) [window(1)] [FCS] [DID] blocks... [checksum(4)], plus
// skippable frames (magic 0x184D2A5? + size).
import zlib from 'node:zlib'

const MAGIC = 0xfd2fb528 // little-endian 28 B5 2F FD
const FCS_SIZES = [0, 1, 2, 2, 4, 4, 8, 8] // index = (FCS_Flag<<1)|Single_Segment

export function decompressFrames(buf) {
  const parts = []
  let p = 0
  while (p < buf.length) {
    if (buf.length - p < 4) break
    const magic = buf.readUInt32LE(p)
    if ((magic & 0xfffffff0) === 0x184d2a50) { // skippable frame
      p += 8 + buf.readUInt32LE(p + 4)
      continue
    }
    if (magic !== MAGIC) throw new Error(`bad zstd magic at ${p}`)
    const fhd = buf[p + 4]
    if (fhd & 0x08) throw new Error('reserved bit set')
    const single = (fhd >> 5) & 1
    const fcsFlag = (fhd >> 6) & 3
    const didFlag = fhd & 3
    const checksum = (fhd >> 2) & 1
    let f = p + 5
    if (!single) f += 1 // Window_Descriptor
    f += FCS_SIZES[(fcsFlag << 1) | single]
    // Dictionary frames can't be decoded without the dict; DSH does not write them.
    if (didFlag !== 0) throw new Error('dictionary frame unsupported')
    f += [0, 1, 2, 4][didFlag]
    // Walk blocks until Last_Block.
    let end = f
    for (;;) {
      if (end + 3 > buf.length) throw new Error('truncated block header')
      const bh = buf[end] | (buf[end + 1] << 8) | (buf[end + 2] << 16)
      const last = bh & 1
      const type = (bh >> 1) & 3
      const size = bh >> 3
      if (type === 3) throw new Error('reserved block type')
      end += 3 + (type === 1 ? 1 : size)
      if (last) break
    }
    const frameEnd = end + (checksum ? 4 : 0)
    parts.push(buf.subarray(p, frameEnd))
    p = frameEnd
  }
  return parts.map((slice) => zlib.zstdDecompressSync(slice))
}

export function decompressConcat(buf) {
  const chunks = decompressFrames(buf)
  return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)
}
