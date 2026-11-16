import { field, fitted, formatNumber, latin1, plural, printable, utf16, utf8 } from './reader.js'
import { hexBytes, item } from './shared.js'

const MAX_DEPTH = 16
const MAX_NODES = 1500

const UNIVERSAL = {
  1: 'BOOLEAN', 2: 'INTEGER', 3: 'BIT STRING', 4: 'OCTET STRING', 5: 'NULL', 6: 'OBJECT IDENTIFIER', 7: 'ObjectDescriptor', 8: 'EXTERNAL', 9: 'REAL',
  10: 'ENUMERATED', 12: 'UTF8String', 13: 'RELATIVE-OID', 16: 'SEQUENCE', 17: 'SET', 18: 'NumericString', 19: 'PrintableString', 20: 'T61String',
  21: 'VideotexString', 22: 'IA5String', 23: 'UTCTime', 24: 'GeneralizedTime', 25: 'GraphicString', 26: 'VisibleString', 27: 'GeneralString', 28: 'UniversalString', 30: 'BMPString'
}

const OIDS = {
  '1.2.840.113549.1.1.1': 'rsaEncryption', '1.2.840.113549.1.1.5': 'sha1WithRSAEncryption', '1.2.840.113549.1.1.11': 'sha256WithRSAEncryption',
  '1.2.840.113549.1.1.12': 'sha384WithRSAEncryption', '1.2.840.113549.1.1.13': 'sha512WithRSAEncryption', '1.2.840.113549.1.1.10': 'RSASSA-PSS',
  '1.2.840.10045.2.1': 'ecPublicKey', '1.2.840.10045.3.1.7': 'prime256v1 (P-256)', '1.3.132.0.34': 'secp384r1 (P-384)', '1.3.132.0.35': 'secp521r1 (P-521)',
  '1.2.840.10045.4.3.2': 'ecdsa-with-SHA256', '1.2.840.10045.4.3.3': 'ecdsa-with-SHA384', '1.2.840.10045.4.3.4': 'ecdsa-with-SHA512',
  '1.3.101.112': 'Ed25519', '1.3.101.113': 'Ed448', '1.3.101.110': 'X25519', '1.2.840.10040.4.1': 'DSA',
  '2.5.4.3': 'commonName', '2.5.4.6': 'countryName', '2.5.4.7': 'localityName', '2.5.4.8': 'stateOrProvinceName', '2.5.4.10': 'organizationName',
  '2.5.4.11': 'organizationalUnitName', '2.5.4.5': 'serialNumber', '2.5.4.9': 'streetAddress', '2.5.4.17': 'postalCode', '2.5.4.97': 'organizationIdentifier',
  '1.2.840.113549.1.9.1': 'emailAddress', '0.9.2342.19200300.100.1.25': 'domainComponent',
  '2.5.29.14': 'subjectKeyIdentifier', '2.5.29.15': 'keyUsage', '2.5.29.17': 'subjectAltName', '2.5.29.18': 'issuerAltName', '2.5.29.19': 'basicConstraints',
  '2.5.29.31': 'cRLDistributionPoints', '2.5.29.32': 'certificatePolicies', '2.5.29.35': 'authorityKeyIdentifier', '2.5.29.37': 'extKeyUsage',
  '1.3.6.1.5.5.7.1.1': 'authorityInfoAccess', '1.3.6.1.4.1.11129.2.4.2': 'signedCertificateTimestampList', '2.5.29.30': 'nameConstraints',
  '1.3.6.1.5.5.7.3.1': 'serverAuth', '1.3.6.1.5.5.7.3.2': 'clientAuth', '1.3.6.1.5.5.7.3.3': 'codeSigning', '1.3.6.1.5.5.7.3.4': 'emailProtection',
  '1.3.6.1.5.5.7.48.1': 'OCSP', '1.3.6.1.5.5.7.48.2': 'caIssuers', '2.23.140.1.2.1': 'domain-validated', '2.23.140.1.2.2': 'organization-validated',
  '1.2.840.113549.1.7.1': 'pkcs7-data', '1.2.840.113549.1.7.2': 'pkcs7-signedData', '1.2.840.113549.1.9.14': 'extensionRequest',
  '2.16.840.1.101.3.4.2.1': 'sha256', '2.16.840.1.101.3.4.2.2': 'sha384', '2.16.840.1.101.3.4.2.3': 'sha512', '1.3.14.3.2.26': 'sha1',
  '1.2.840.113549.1.5.13': 'PBES2', '1.2.840.113549.1.5.12': 'PBKDF2', '2.16.840.1.101.3.4.1.42': 'aes256-CBC', '1.2.840.113549.1.12.10.1.2': 'pkcs8ShroudedKeyBag'
}

const SHORT_NAMES = { commonName: 'CN', countryName: 'C', localityName: 'L', stateOrProvinceName: 'ST', organizationName: 'O', organizationalUnitName: 'OU', emailAddress: 'E', domainComponent: 'DC', serialNumber: 'SERIALNUMBER' }

/** Reads one tag-length header at `pos`; null if malformed or beyond `end` */
export function readTL(bytes, pos, end) {
  if (pos + 2 > end) return null
  const tagByte = bytes[pos]
  let number = tagByte & 0x1F
  let p = pos + 1
  if (number === 0x1F) {
    number = 0
    for (let i = 0; i < 4; i++) {
      if (p >= end) return null
      const b = bytes[p++]
      number = number * 128 + (b & 0x7F)
      if (!(b & 0x80)) break
      if (i === 3) return null
    }
  }
  if (p >= end) return null
  const tagEnd = p
  const first = bytes[p++]
  let length
  if (first < 0x80) {
    length = first
  } else if (first === 0x80) {
    return null
  } else {
    const count = first & 0x7F
    if (count > 4 || p + count > end) return null
    length = 0
    for (let i = 0; i < count; i++) length = length * 256 + bytes[p++]
  }
  return { cls: tagByte >> 6, constructed: (tagByte & 0x20) !== 0, number, tagByte, tagEnd, headerEnd: p, length, end: p + length }
}

function decodeOid(bytes, start, end) {
  const parts = []
  let value = 0
  for (let i = start; i < end && parts.length < 64; i++) {
    value = value * 128 + (bytes[i] & 0x7F)
    if (!(bytes[i] & 0x80)) {
      if (parts.length === 0) {
        const first = value < 40 ? 0 : value < 80 ? 1 : 2
        parts.push(first, value - first * 40)
      } else {
        parts.push(value)
      }
      value = 0
    }
  }
  return parts.join('.')
}

function decodeTime(text, generalized) {
  const m = generalized ? text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?/) : text.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?/)
  if (!m) return text
  let year = Number(m[1])
  if (!generalized) year += year < 50 ? 2000 : 1900
  return `${year}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] || '00'}${/Z$/.test(text) ? ' UTC' : ''}`
}

function tagName(tl) {
  if (tl.cls === 0) return UNIVERSAL[tl.number] || `UNIVERSAL ${tl.number}`
  if (tl.cls === 2) return `[${tl.number}]`
  return `${tl.cls === 1 ? 'APPLICATION' : 'PRIVATE'} ${tl.number}`
}

// Whether a byte range holds exactly one well-formed DER element (checked a few levels deep)
function isWellFormed(bytes, start, end, depth = 0) {
  const tl = readTL(bytes, start, end)
  if (!tl || tl.end !== end) return false
  if (!tl.constructed || depth >= 3) return true
  let p = tl.headerEnd
  let count = 0
  while (p < end && count++ < 256) {
    const child = readTL(bytes, p, end)
    if (!child || child.end > end || !isWellFormed(bytes, p, child.end, depth + 1)) return false
    p = child.end
  }
  return p === end
}

function textValue(bytes, tl) {
  const start = tl.headerEnd
  const length = Math.min(tl.length, 1024)
  if (tl.number === 30) return utf16(bytes, start, length, false)
  if (tl.number === 12) return utf8(bytes, start, length)
  return latin1(bytes, start, length)
}

function parseDER(bytes) {
  const warnings = []
  const summary = []
  let nodes = 0
  let maxDepth = 0
  let truncatedTree = false

  // Builds the field tree and a parallel node tree for interpretation
  const walk = (pos, end, depth) => {
    const fields = []
    const list = []
    while (pos < end) {
      if (nodes >= MAX_NODES) {
        truncatedTree = true
        fields.push(field(`… elements not shown after ${formatNumber(MAX_NODES)}`, pos, end - pos, undefined, 'Left out to keep the tree readable', 'data'))
        break
      }
      const tl = readTL(bytes, pos, end)
      if (!tl || tl.end > end) {
        warnings.push(`Malformed or truncated element at offset ${pos}`)
        fields.push(field('Unparsed bytes', pos, end - pos, undefined, 'Not valid DER', 'data'))
        break
      }
      nodes++
      maxDepth = Math.max(maxDepth, depth)
      const name = tagName(tl)
      const node = { ...tl, offset: pos, name, children: [] }
      const children = [
        field('Tag', pos, tl.tagEnd - pos, `0x${tl.tagByte.toString(16).toUpperCase().padStart(2, '0')} (${['universal', 'application', 'context-specific', 'private'][tl.cls]}, ${tl.constructed ? 'constructed' : 'primitive'})`, 'Identifier octets', 'magic'),
        field('Length', tl.tagEnd, tl.headerEnd - tl.tagEnd, formatNumber(tl.length), 'Definite length octets', 'size')
      ]
      let value
      const s = tl.headerEnd
      let encapsulated = null
      if (tl.constructed) {
        if (depth < MAX_DEPTH) {
          const inner = walk(s, tl.end, depth + 1)
          children.push(...inner.fields)
          node.children = inner.list
        } else if (tl.length > 0) {
          children.push(field('Content', s, tl.length, undefined, 'Nested too deeply to show', 'data'))
        }
        value = plural(node.children.length, 'element')
      } else if (tl.cls === 0) {
        if (tl.number === 6) {
          node.oid = decodeOid(bytes, s, tl.end)
          value = OIDS[node.oid] ? `${node.oid} (${OIDS[node.oid]})` : node.oid
        } else if (tl.number === 2 || tl.number === 10) {
          if (tl.length <= 6) {
            let n = 0
            for (let i = s; i < tl.end; i++) n = n * 256 + bytes[i]
            if (tl.length > 0 && bytes[s] & 0x80) n -= 2 ** (8 * tl.length)
            value = String(n)
            node.number_ = n
          } else {
            const skip = bytes[s] === 0 ? 1 : 0
            value = `0x${hexBytes(bytes, s + skip, Math.min(20, tl.length - skip))}${tl.length - skip > 20 ? '…' : ''} (${(tl.length - skip) * 8} bits)`
            node.bits = (tl.length - skip) * 8
          }
          node.hex = hexBytes(bytes, s, Math.min(tl.length, 32))
        } else if (tl.number === 1) {
          value = bytes[s] ? 'true' : 'false'
          node.bool = bytes[s] !== 0
        } else if (tl.number === 5) {
          value = 'null'
        } else if (tl.number === 23 || tl.number === 24) {
          value = decodeTime(latin1(bytes, s, tl.length), tl.number === 24)
          node.text = value
        } else if (tl.number === 3 || tl.number === 4) {
          const unused = tl.number === 3 ? bytes[s] : 0
          const contentStart = tl.number === 3 ? s + 1 : s
          value = tl.number === 3 ? `${formatNumber(Math.max(0, (tl.length - 1) * 8 - unused))} bits` : `${formatNumber(tl.length)} bytes`
          node.bytes = bytes.subarray(contentStart, tl.end)
          // Keys and extensions are DER inside a string; show it as a subtree
          if (depth < MAX_DEPTH && tl.length > 2 && unused === 0 && isWellFormed(bytes, contentStart, tl.end)) {
            const inner = walk(contentStart, tl.end, depth + 1)
            if (tl.number === 3) children.push(field('Unused bits', s, 1, unused, 'Padding bits in the last byte', 'count'))
            children.push(...inner.fields)
            node.children = inner.list
            encapsulated = true
            value += ', encapsulates DER'
          }
        } else if (UNIVERSAL[tl.number] && /String$/.test(UNIVERSAL[tl.number])) {
          node.text = textValue(bytes, tl)
          value = `"${printable(node.text, 120)}"`
        }
      } else if (tl.cls === 2) {
        const text = latin1(bytes, s, Math.min(tl.length, 200))
        node.text = text
        value = /^[\x20-\x7E]*$/.test(text) && tl.length > 0 ? `"${printable(text, 80)}"` : `${formatNumber(tl.length)} bytes`
      }
      if (!tl.constructed && !encapsulated && tl.length > 0) children.push(field('Value', s, tl.length, undefined, 'Content octets', 'data'))
      const description = node.oid && OIDS[node.oid] ? OIDS[node.oid] : tl.constructed ? 'Constructed element' : 'Primitive element'
      fields.push(field(name, pos, tl.end - pos, value, description, tl.constructed ? 'header' : 'data', children))
      list.push(node)
      pos = tl.end
    }
    return { fields, list }
  }

  const outer = readTL(bytes, 0, bytes.length)
  const { fields, list } = walk(0, outer ? Math.min(outer.end, bytes.length) : bytes.length, 0)
  if (outer && outer.end < bytes.length) {
    const rest = bytes.length - outer.end
    fields.push(field('Trailing data', outer.end, rest, `${formatNumber(rest)} bytes`, 'After the top-level element', 'data'))
    warnings.push(`${plural(rest, 'byte')} after the top-level element`)
  }
  if (outer && outer.end > bytes.length) warnings.push('The top-level element is truncated')
  if (truncatedTree) warnings.push(`Only the first ${formatNumber(MAX_NODES)} elements are shown`)

  const root = list[0]
  let formatName = 'DER-encoded ASN.1'
  const cert = root && interpretCertificate(root)
  if (cert) {
    formatName = 'X.509 Certificate (DER)'
    summary.push(...cert)
  } else if (root && isCsr(root)) {
    formatName = 'Certificate Signing Request (DER)'
    const subject = root.children[0].children[1]
    summary.push(item('Subject', describeName(subject)))
  } else if (root && root.children[0] && root.children[0].name === 'INTEGER' && root.children[1] && root.children[1].name === 'SEQUENCE' && root.children[2] && root.children[2].name === 'OCTET STRING') {
    formatName = 'PKCS#8 Private Key (DER)'
    const alg = root.children[1].children[0]
    summary.push(item('Key Algorithm', alg && alg.oid ? OIDS[alg.oid] || alg.oid : 'unknown'))
    warnings.push('This file contains an unencrypted private key')
  } else if (root && root.children[0] && root.children[0].oid === '1.2.840.113549.1.7.2') {
    formatName = 'PKCS#7 Signed Data (DER)'
  }
  summary.push(item('Elements', formatNumber(nodes)))
  summary.push(item('Maximum Depth', maxDepth + 1))
  return { formatName, summary, fields, regions: [{ name: 'ASN.1 structure', offset: 0, length: Math.min(bytes.length, outer ? outer.end : bytes.length), kind: 'data' }], warnings }
}

function describeName(node) {
  if (!node || node.name !== 'SEQUENCE') return 'unknown'
  const parts = []
  for (const set of node.children.slice(0, 32)) {
    for (const pair of set.children.slice(0, 4)) {
      const [oid, value] = pair.children
      if (!oid || !oid.oid) continue
      const name = OIDS[oid.oid] || oid.oid
      parts.push(`${SHORT_NAMES[name] || name}=${printable(value && value.text !== undefined ? value.text : '?', 120)}`)
    }
  }
  return parts.join(', ') || '(empty)'
}

function isCsr(root) {
  const info = root.children[0]
  return root.children.length === 3 && info && info.name === 'SEQUENCE' && info.children[0] && info.children[0].name === 'INTEGER' &&
    info.children[1] && info.children[1].name === 'SEQUENCE' && info.children[2] && info.children[2].name === 'SEQUENCE' && info.children[3] && info.children[3].name === '[0]'
}

// Recognises Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
function interpretCertificate(root) {
  if (root.name !== 'SEQUENCE' || root.children.length !== 3) return null
  const [tbs, sigAlg, sig] = root.children
  if (!tbs || tbs.name !== 'SEQUENCE' || sigAlg.name !== 'SEQUENCE' || sig.name !== 'BIT STRING') return null
  let i = 0
  let version = 1
  if (tbs.children[0] && tbs.children[0].name === '[0]') {
    const v = tbs.children[0].children[0]
    version = v && v.number_ !== undefined ? v.number_ + 1 : 3
    i = 1
  }
  const [serial, , issuer, validity, subject, spki] = tbs.children.slice(i)
  if (!serial || serial.name !== 'INTEGER' || !validity || validity.name !== 'SEQUENCE' || !spki || spki.name !== 'SEQUENCE') return null
  const items = []
  const subjectText = describeName(subject)
  const issuerText = describeName(issuer)
  items.push(item('Subject', subjectText))
  items.push(item('Issuer', issuerText))
  if (subjectText === issuerText) items.push(item('Self-signed', 'Yes (subject equals issuer)'))
  items.push(item('Version', `v${version}`))
  items.push(item('Serial Number', serial.number_ !== undefined ? String(serial.number_) : `0x${serial.hex}${serial.bits > 256 ? '…' : ''}`))
  const [notBefore, notAfter] = validity.children
  if (notBefore && notAfter) {
    items.push(item('Valid From', notBefore.text || '?'))
    items.push(item('Valid Until', notAfter.text || '?'))
  }
  const sigOid = sigAlg.children[0] && sigAlg.children[0].oid
  if (sigOid) items.push(item('Signature Algorithm', OIDS[sigOid] || sigOid))
  const keyAlg = spki.children[0]
  const keyOid = keyAlg && keyAlg.children[0] && keyAlg.children[0].oid
  if (keyOid) {
    let detail = OIDS[keyOid] || keyOid
    const param = keyAlg.children[1]
    if (param && param.oid) detail += `, ${OIDS[param.oid] || param.oid}`
    const key = spki.children[1]
    if (keyOid === '1.2.840.113549.1.1.1' && key && key.children[0] && key.children[0].children[0]) detail += `, ${key.children[0].children[0].bits || '?'} bits`
    items.push(item('Public Key', detail))
  }
  const extensions = tbs.children.find(child => child.name === '[3]')
  const list = extensions && extensions.children[0] ? extensions.children[0].children : []
  const names = []
  for (const ext of list) {
    const oid = ext.children[0] && ext.children[0].oid
    const valueNode = ext.children[ext.children.length - 1]
    if (oid === '2.5.29.17' && valueNode && valueNode.children[0]) {
      for (const general of valueNode.children[0].children.slice(0, 100)) {
        if (general.text !== undefined) names.push(general.number === 2 ? `DNS:${general.text}` : general.number === 1 ? `email:${general.text}` : general.number === 6 ? `URI:${general.text}` : `[${general.number}]`)
        if (general.number === 7 && general.text !== undefined) names[names.length - 1] = `IP:${[...general.text].map(c => c.charCodeAt(0)).join('.')}`
      }
    }
    if (oid === '2.5.29.19' && valueNode && valueNode.children[0]) {
      const ca = valueNode.children[0].children.find(child => child.name === 'BOOLEAN')
      items.push(item('Certificate Authority', ca && ca.bool ? 'Yes' : 'No'))
    }
  }
  if (names.length) items.push(item('Subject Alt Names', `${names.length}`, names.map(n => printable(n, 120))))
  if (list.length) items.push(item('Extensions', formatNumber(list.length), list.map(ext => {
    const oid = ext.children[0] && ext.children[0].oid
    const critical = ext.children.some(child => child.name === 'BOOLEAN' && child.bool)
    return `${OIDS[oid] || oid}${critical ? ' (critical)' : ''}`
  })))
  return items
}

/** @type {import('../analysis/types.js').FormatModule} */
export default {
  id: 'der',
  name: 'DER-encoded ASN.1',
  category: 'data',
  // No magic: a SEQUENCE that spans the whole file and holds well-formed elements
  detect: bytes => {
    if (bytes.length < 8 || bytes[0] !== 0x30) return false
    const tl = readTL(bytes, 0, bytes.length)
    if (!tl || tl.end !== bytes.length || tl.length < 4) return false
    const first = bytes[tl.headerEnd]
    if (![0x30, 0x31, 0x02, 0x06, 0xA0, 0x04, 0x03, 0x05].includes(first)) return false
    return isWellFormed(bytes, 0, bytes.length)
  },
  parse: fitted(parseDER)
}
