// Faithful (de)serialisation of mDNS resource-record rdata to/from a
// JSON-storable form, so cached records can be re-emitted byte-for-byte.
//
// `multicast-dns` (via `dns-packet`) represents rdata differently per type:
//   PTR        -> string (a domain name)
//   SRV        -> { priority, weight, port, target }
//   TXT        -> array of Buffers (one per key/value chunk)
//   A / AAAA   -> string (an IP address)
// Everything except TXT is already JSON-friendly. TXT buffers are encoded as
// base64 strings so arbitrary binary metadata round-trips intact.

export const RECORD_TYPES = ['PTR', 'SRV', 'TXT', 'A', 'AAAA'];

/** Convert live rdata (from multicast-dns) into a JSON-serialisable value. */
export function encodeRdata(type, data) {
  if (type === 'TXT') {
    const chunks = Array.isArray(data) ? data : [data];
    return chunks.map((c) =>
      Buffer.isBuffer(c) ? c.toString('base64') : Buffer.from(String(c)).toString('base64'),
    );
  }
  return data;
}

/** Reverse of {@link encodeRdata}: produce rdata ready to hand back to multicast-dns. */
export function decodeRdata(type, encoded) {
  if (type === 'TXT') {
    const chunks = Array.isArray(encoded) ? encoded : [encoded];
    return chunks.map((s) => Buffer.from(String(s), 'base64'));
  }
  return encoded;
}

/** Serialise an entire record `{ name, type, ttl, data }` for the DB `records` table. */
export function serializeRecord(rec) {
  return {
    type: rec.type,
    name: rec.name,
    ttl: rec.ttl ?? 120,
    data: JSON.stringify(encodeRdata(rec.type, rec.data)),
  };
}

/** Inverse of {@link serializeRecord}: a DB row -> a multicast-dns answer object. */
export function deserializeRecord(row) {
  return {
    name: row.name,
    type: row.type,
    ttl: row.ttl,
    data: decodeRdata(row.type, JSON.parse(row.data)),
  };
}

/** Render TXT rdata as readable `key=value` strings, for display in the UI. */
export function txtToStrings(data) {
  const chunks = Array.isArray(data) ? data : [data];
  return chunks
    .map((c) => (Buffer.isBuffer(c) ? c.toString('utf8') : String(c)))
    .filter((s) => s.length > 0);
}
