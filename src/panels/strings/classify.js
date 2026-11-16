/**
 * Quick-filter classes for extracted strings, as a bitmask. The patterns
 * favour precision over recall: a class should not fill up with noise from
 * random bytes that happen to be printable.
 */

export const CLASSES = [
  { id: 'url', bit: 1, label: 'URL' },
  { id: 'ip', bit: 2, label: 'IP address' },
  { id: 'email', bit: 4, label: 'E-mail' },
  { id: 'path', bit: 8, label: 'File path' },
  { id: 'registry', bit: 16, label: 'Registry key' },
  { id: 'guid', bit: 32, label: 'GUID' },
  { id: 'message', bit: 64, label: 'Format / message' }
]

const URL_RE = /\b(?:https?|ftps?|wss?|file|ldaps?|smb|sftp):\/\/[^\s"'<>]{2,}/i
const IPV4_RE = /(?<![\w.])(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(?![\w]|\.\d)/
const VERSION_RE = /version|\bv\d|=\d+\.\d+\.\d+\.\d+/i
const IPV6_CANDIDATE_RE = /(?<![\w:.])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?:(?<=:)(?:\d{1,3}\.){3}\d{1,3})?(?![\w:])/gi
// The top-level domain is all lowercase or all uppercase, unlike most noise
const EMAIL_RE = /(?<![\w.%+-])[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*\.(?:[a-z]{2,24}|[A-Z]{2,24})(?![\w-])/
const WINDOWS_PATH_RE = /(?:^|[\s"'=(])(?:[a-z]:\\(?:[\w .$()~-]+\\)*[\w .$()~-]*|\\\\[\w.$-]{2,}\\[\w.$-]+|%[a-z_]+%\\[\w .$-]+)(?=$|[\s"',;)\\])/i
// A known root, a relative prefix, or three or more all-lowercase segments
const UNIX_PATH_RE = /(?:^|[\s"'=(:])(?:\/(?:usr|etc|var|tmp|bin|sbin|lib|lib32|lib64|opt|home|root|dev|proc|sys|run|mnt|media|srv|System|Library|Applications|Users|Volumes|private)\/|(?:~|\.{1,2})\/[\w.+@-]+\/[\w.+@-]|\/[a-z0-9._+@-]+\/[a-z0-9._+@-]+\/[a-z0-9._+@-]+)/
const REGISTRY_RE = /\b(?:HKEY_(?:LOCAL_MACHINE|CURRENT_USER|CLASSES_ROOT|USERS|CURRENT_CONFIG|PERFORMANCE_DATA)|HK(?:LM|CU|CR|CC|U))(?:\\|\b)|\b(?:SOFTWARE|SYSTEM)\\(?:Microsoft|Classes|CurrentControlSet|Policies|Wow6432Node|ControlSet\d{3})\b/i
const GUID_RE = /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/i
const FORMAT_RE = /%(?:[-+ #0']{0,4})(?:\d{1,3}|\*)?(?:\.(?:\d{1,3}|\*))?(?:hh|h|ll|l|L|q|j|z|t|I64|I32)?[diouxXeEfgGcsSp]/g
const MESSAGE_RE = /\b(?:error|errno|fail(?:s|ed|ure)?|cannot|can't|could ?not|couldn't|unable|invalid|not found|no such|denied|unexpected|missing|fatal|warning|abort(?:ed|ing)?|unsupported|overflow|corrupt(?:ed)?|out of memory|illegal|exception|too (?:many|large|long|big)|expected)\b|\busage:/i
const WORD_RE = /[a-z]{2,}/i
// A word as it appears in prose: lowercase, optionally capitalised
const PROSE_WORD_RE = /\b[A-Za-z][a-z]{2,}\b/g

function isIpv6(candidate, standalone) {
  let tail = candidate
  const v4 = /(?:\d{1,3}\.){3}\d{1,3}$/.exec(tail)
  if (v4) {
    if (!IPV4_RE.test(v4[0])) return false
    tail = tail.slice(0, v4.index) + '0:0'
  }
  const halves = tail.split('::')
  if (halves.length > 2) return false
  const groups = halves.flatMap(half => (half === '' ? [] : half.split(':')))
  if (groups.some(group => group.length === 0 || group.length > 4)) return false
  if (halves.length === 1) return groups.length === 8
  // A compressed address with a single group ("::1") only counts on its own
  return groups.length <= 7 && (groups.length >= 2 || standalone)
}

function hasIpv6(text) {
  IPV6_CANDIDATE_RE.lastIndex = 0
  let match
  while ((match = IPV6_CANDIDATE_RE.exec(text)) !== null) {
    if (match[0].includes('::') || match[0].split(':').length === 8) {
      if (/\d/.test(match[0]) && isIpv6(match[0], match[0].length === text.trim().length)) return true
    }
    if (match[0].length === 0) IPV6_CANDIDATE_RE.lastIndex++
  }
  return false
}

function hasWindowsPath(text) {
  const match = WINDOWS_PATH_RE.exec(text)
  return match !== null && /[a-z0-9_]{3}/i.test(match[0].slice(3))
}

function looksLikeMessage(text) {
  if (text.includes('%')) {
    FORMAT_RE.lastIndex = 0
    const conversions = text.match(FORMAT_RE)
    if (conversions) {
      // "%d" inside random printable noise is common; a format string also has words or spaces
      const words = text.replace(FORMAT_RE, ' ').match(PROSE_WORD_RE) || []
      if (words.length >= 2 || (words.length === 1 && conversions.length >= 2)) return true
    }
  }
  if (text.includes(' ') && MESSAGE_RE.test(text)) {
    const words = text.match(PROSE_WORD_RE) || []
    return words.length >= 2
  }
  return false
}

/**
 * @param {string} text
 * @returns {number} bitmask of CLASSES bits
 */
export function classify(text) {
  let mask = 0
  if (text.length < 3) return 0
  const hasColon = text.includes(':')
  const hasDot = text.includes('.')
  const hasBackslash = text.includes('\\')
  if (hasColon && text.includes('//') && URL_RE.test(text)) mask |= 1
  if ((hasDot && IPV4_RE.test(text) && !VERSION_RE.test(text)) || (hasColon && hasIpv6(text))) mask |= 2
  if (text.includes('@') && hasDot && EMAIL_RE.test(text)) mask |= 4
  if ((hasBackslash && hasWindowsPath(text)) || (text.includes('/') && !(mask & 1) && UNIX_PATH_RE.test(text) && WORD_RE.test(text))) mask |= 8
  if (hasBackslash && REGISTRY_RE.test(text)) mask |= 16
  if (text.length >= 36 && text.includes('-') && GUID_RE.test(text)) mask |= 32
  if ((text.includes('%') || text.includes(' ')) && looksLikeMessage(text)) mask |= 64
  return mask
}
