// Demangler for Itanium C++ names (_Z…) and legacy Rust names. It covers the
// common grammar and returns null for anything outside it, so a name is only
// ever shown demangled when every part of it was understood. Output follows
// GNU c++filt (e.g. "char const*", "std::vector<int, std::allocator<int> >").

class Fail extends Error {}
const fail = () => { throw new Fail() }

const MAX_LENGTH = 4096
const MAX_DEPTH = 64

const BUILTINS = {
  v: 'void', w: 'wchar_t', b: 'bool', c: 'char', a: 'signed char', h: 'unsigned char', s: 'short',
  t: 'unsigned short', i: 'int', j: 'unsigned int', l: 'long', m: 'unsigned long', x: 'long long',
  y: 'unsigned long long', n: '__int128', o: 'unsigned __int128', f: 'float', d: 'double', e: 'long double',
  g: '__float128', z: '...'
}
const D_BUILTINS = {
  d: 'decimal64', e: 'decimal128', f: 'decimal32', h: 'half', i: 'char32_t', s: 'char16_t', u: 'char8_t',
  a: 'auto', c: 'decltype(auto)', n: 'decltype(nullptr)'
}
// Literal suffixes as c++filt prints them; other types print as "(type)value"
const LITERAL_SUFFIX = { i: '', j: 'u', l: 'l', m: 'ul', x: 'll', y: 'ull' }

const OPERATORS = {
  nw: 'new', na: 'new[]', dl: 'delete', da: 'delete[]', ps: '+', ng: '-', ad: '&', de: '*', co: '~',
  pl: '+', mi: '-', ml: '*', dv: '/', rm: '%', an: '&', or: '|', eo: '^', aS: '=', pL: '+=', mI: '-=',
  mL: '*=', dV: '/=', rM: '%=', aN: '&=', oR: '|=', eO: '^=', ls: '<<', rs: '>>', lS: '<<=', rS: '>>=',
  eq: '==', ne: '!=', lt: '<', gt: '>', le: '<=', ge: '>=', ss: '<=>', nt: '!', aa: '&&', oo: '||',
  pp: '++', mm: '--', cm: ',', pm: '->*', pt: '->', cl: '()', ix: '[]', qu: '?'
}

// c++filt prints these in full (it demangles verbosely)
const STD_ABBREVIATIONS = {
  a: ['std::allocator', 'allocator'],
  b: ['std::basic_string', 'basic_string'],
  s: ['std::basic_string<char, std::char_traits<char>, std::allocator<char> >', 'basic_string'],
  i: ['std::basic_istream<char, std::char_traits<char> >', 'basic_istream'],
  o: ['std::basic_ostream<char, std::char_traits<char> >', 'basic_ostream'],
  d: ['std::basic_iostream<char, std::char_traits<char> >', 'basic_iostream']
}

// ---------------------------------------------------------------- type printing

const named = text => ({ kind: 'name', text })

function isFunc(t) { return t.kind === 'func' }

function left(t) {
  switch (t.kind) {
    case 'name': return t.text
    case 'qual':
      if (isFunc(t.inner)) fail()
      return `${left(t.inner)} ${t.quals}`
    case 'ptr': {
      const inner = t.inner
      if (isFunc(inner)) return `${typeText(inner.ret)} (${t.op}`
      if (inner.kind === 'array') return `${left(inner)}(${t.op}`
      return `${left(inner)}${t.op}`
    }
    case 'func': return `${typeText(t.ret)} `
    case 'array': return t.inner.kind === 'array' ? left(t.inner) : `${left(t.inner)} `
    case 'ptrmem': {
      const member = t.member
      if (isFunc(member)) return `${typeText(member.ret)} (${typeText(t.cls)}::*`
      if (member.kind === 'qual' && isFunc(member.inner)) return `${typeText(member.inner.ret)} (${typeText(t.cls)}::*`
      if (member.kind === 'array') fail()
      return `${left(member)} ${typeText(t.cls)}::*`
    }
    default: return fail()
  }
}

function right(t) {
  switch (t.kind) {
    case 'name': return ''
    case 'qual': return right(t.inner)
    case 'ptr': {
      const inner = t.inner
      if (isFunc(inner)) return `)${funcSuffix(inner)}`
      if (inner.kind === 'array') return `) ${arrayDims(inner)}`
      return right(inner)
    }
    case 'func': return funcSuffix(t)
    case 'array': return arrayDims(t)
    case 'ptrmem': {
      const member = t.member
      if (isFunc(member)) return `)${funcSuffix(member)}`
      if (member.kind === 'qual' && isFunc(member.inner)) return `)${funcSuffix(member.inner)} ${member.quals}`
      return right(member)
    }
    default: return fail()
  }
}

function arrayDims(t) {
  let out = `[${t.dim}]`
  let inner = t.inner
  while (inner.kind === 'array') {
    out += `[${inner.dim}]`
    inner = inner.inner
  }
  return out + right(inner)
}

function funcSuffix(f) {
  return `(${paramList(f.params)})${f.ref || ''}`
}

function paramList(params) {
  if (params.length === 1 && params[0].kind === 'name' && params[0].text === 'void') return ''
  return params.map(typeText).join(', ')
}

function typeText(t) {
  if (t.kind === 'array' && t.inner.kind !== 'array') return `${left(t.inner)} ${arrayDims(t)}`
  if (t.kind === 'func') return `${typeText(t.ret)} (${paramList(t.params)})${t.ref || ''}`
  return left(t) + right(t)
}

function withArgs(name, args) {
  const list = args.join(', ')
  return `${name}${name.endsWith('<') ? ' ' : ''}<${list}${list.endsWith('>') ? ' ' : ''}>`
}

// ---------------------------------------------------------------- parser

class Parser {
  constructor(text) {
    this.s = text
    this.i = 0
    this.subs = []
    this.templateArgs = null
    this.argTypes = new Map() // printed template argument -> its type, to see through T_
    this.depth = 0
  }

  peek(n = 0) { return this.s[this.i + n] }
  eat(ch) {
    if (this.s.startsWith(ch, this.i)) {
      this.i += ch.length
      return true
    }
    return false
  }
  expect(ch) { if (!this.eat(ch)) fail() }
  enter() { if (++this.depth > MAX_DEPTH) fail() }

  number() {
    const negative = this.eat('n')
    const start = this.i
    while (this.i < this.s.length && this.s[this.i] >= '0' && this.s[this.i] <= '9') this.i++
    if (this.i === start) fail()
    const text = this.s.slice(start, this.i)
    if (text.length > 1 && text[0] === '0') fail()
    return negative ? -Number(text) : Number(text)
  }

  seqId() {
    // base-36 with digits and upper-case letters, terminated by '_'
    if (this.eat('_')) return 0
    let value = 0
    const start = this.i
    while (/[0-9A-Z]/.test(this.peek() || '')) {
      value = value * 36 + parseInt(this.s[this.i], 36)
      this.i++
    }
    if (this.i === start) fail()
    this.expect('_')
    return value + 1
  }

  sourceName() {
    const length = this.number()
    if (length <= 0 || this.i + length > this.s.length) fail()
    const id = this.s.slice(this.i, this.i + length)
    this.i += length
    if (id.startsWith('_GLOBAL__N')) return '(anonymous namespace)'
    if (!/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(id)) fail()
    return id
  }

  abiTags(name) {
    let out = name
    while (this.eat('B')) out += `[abi:${this.sourceName()}]`
    return out
  }

  // ---------------------------------------------------------------- encodings
  mangled() {
    this.expect('_Z')
    let text = this.encoding(true)
    // Clone suffixes such as .cold, .isra.0, .constprop.1
    while (this.peek() === '.') {
      const match = /^(\.[A-Za-z_]+(?:\.\d+)*|(?:\.\d+)+)/.exec(this.s.slice(this.i))
      if (!match) fail()
      text += ` [clone ${match[1]}]`
      this.i += match[1].length
    }
    if (this.i !== this.s.length) fail()
    return text
  }

  encoding(top) {
    this.enter()
    try {
      if (this.peek() === 'T' || (this.peek() === 'G' && /[VRT]/.test(this.peek(1) || ''))) return this.specialName()
      const savedArgs = this.templateArgs
      const name = this.name()
      if (this.i >= this.s.length || this.peek() === 'E' || this.peek() === '.') {
        if (!top && this.peek() !== 'E') fail()
        if (name.cv || name.ref) fail()
        return name.text
      }
      // A function: template functions (other than constructors, destructors
      // and conversions) encode their return type first
      if (name.templateArgs) this.templateArgs = name.templateArgs
      let ret = null
      if (name.templateArgs && !name.ctorDtor && !name.conversion) ret = this.type()
      const params = this.bareFunctionType()
      if (!name.templateArgs) this.templateArgs = savedArgs
      let text = `${name.text}(${paramList(params)})`
      if (name.cv) text += ` ${name.cv}`
      if (name.ref) text += ` ${name.ref}`
      if (ret) {
        // c++filt's rendering of return types inside local names is not modelled
        if (this.inLocal || hasDeclarator(ret)) fail()
        text = `${typeText(ret)} ${text}`
      }
      return text
    } finally {
      this.depth--
    }
  }

  bareFunctionType() {
    const params = []
    while (this.i < this.s.length && this.peek() !== 'E' && this.peek() !== '.') params.push(this.type())
    if (!params.length) fail()
    return params
  }

  specialName() {
    if (this.eat('TV')) return `vtable for ${typeText(this.type())}`
    if (this.eat('TT')) return `VTT for ${typeText(this.type())}`
    if (this.eat('TI')) return `typeinfo for ${typeText(this.type())}`
    if (this.eat('TS')) return `typeinfo name for ${typeText(this.type())}`
    if (this.eat('TW')) return `TLS wrapper function for ${this.name().text}`
    if (this.eat('TH')) return `TLS init function for ${this.name().text}`
    if (this.eat('Th')) {
      this.number()
      this.expect('_')
      return `non-virtual thunk to ${this.encoding(false)}`
    }
    if (this.eat('Tv')) {
      this.number()
      this.expect('_')
      this.number()
      this.expect('_')
      return `virtual thunk to ${this.encoding(false)}`
    }
    if (this.eat('GTt')) return `transaction clone for ${this.encoding(false)}`
    if (this.eat('GV')) return `guard variable for ${this.name().text}`
    if (this.eat('GR')) {
      const name = this.name().text
      const n = this.peek() === '_' ? (this.i++, 0) : this.seqId()
      return `reference temporary #${n} for ${name}`
    }
    return fail()
  }

  // ---------------------------------------------------------------- names
  // Returns { text, templateArgs?, cv?, ref?, ctorDtor?, conversion? }
  name() {
    this.enter()
    try {
      const c = this.peek()
      if (c === 'N') return this.nestedName()
      if (c === 'Z') return this.localName()
      let text
      let conversion = false
      let fromSubstitution = false
      if (this.eat('St')) {
        const part = this.unqualifiedName(null)
        text = `std::${part.text}`
        conversion = part.conversion
      } else if (c === 'S') {
        const sub = this.substitution()
        if (this.peek() !== 'I') fail()
        text = sub.text
        fromSubstitution = true
      } else {
        const part = this.unqualifiedName(null)
        text = part.text
        conversion = part.conversion
        if (part.ctorDtor) fail()
      }
      if (this.peek() === 'I') {
        if (!fromSubstitution) this.subs.push(named(text))
        const args = this.templateArgsList()
        return { text: withArgs(text, args), templateArgs: args, conversion }
      }
      return { text, conversion }
    } finally {
      this.depth--
    }
  }

  nestedName() {
    this.expect('N')
    let cv = ''
    const quals = []
    while (/[rVK]/.test(this.peek() || '')) {
      const q = this.s[this.i++]
      quals.push(q)
    }
    if (quals.length) cv = qualText(quals)
    let ref = ''
    if (this.eat('R')) ref = '&'
    else if (this.eat('O')) ref = '&&'

    let text = ''
    let lastName = ''
    let templateArgs = null
    let ctorDtor = false
    let conversion = false
    let parts = 0
    while (!this.eat('E')) {
      if (this.i >= this.s.length) fail()
      templateArgs = null
      let candidate = true
      const c = this.peek()
      if (c === 'I') {
        if (!parts) fail()
        const args = this.templateArgsList()
        text = withArgs(text, args)
        templateArgs = args
      } else if (c === 'S' && this.peek(1) !== 't') {
        if (parts) fail()
        const sub = this.substitution()
        text = sub.text
        lastName = sub.last || sub.text
        candidate = false // already in the table
      } else if (c === 'T') {
        if (parts) fail()
        text = typeText(this.templateParam())
        lastName = text
      } else if (c === 'D' && /[tT]/.test(this.peek(1) || '')) {
        fail()
      } else {
        if (this.eat('St')) {
          if (parts) fail()
          text = 'std'
          parts++
        }
        const part = this.unqualifiedName(lastName)
        ctorDtor = part.ctorDtor
        conversion = part.conversion
        text = text ? `${text}::${part.text}` : part.text
        lastName = part.base
      }
      parts++
      // Every prefix is a substitution candidate; the complete name is not
      if (candidate && this.peek() !== 'E') this.subs.push(named(text))
    }
    if (!parts) fail()
    return { text, templateArgs, cv, ref, ctorDtor, conversion }
  }

  localName() {
    this.expect('Z')
    const savedArgs = this.templateArgs
    this.inLocal = (this.inLocal || 0) + 1
    const outer = this.encoding(false)
    this.inLocal--
    this.templateArgs = savedArgs
    this.expect('E')
    if (this.eat('s')) {
      this.discriminator()
      return { text: `${outer}::string literal` }
    }
    if (this.peek() === 'd') fail()
    const inner = this.name()
    this.discriminator()
    return { ...inner, text: `${outer}::${inner.text}` }
  }

  discriminator() {
    if (this.peek() !== '_') return
    if (this.s.startsWith('__', this.i)) {
      this.i += 2
      this.number()
      this.expect('_')
    } else {
      this.i++
      if (!/[0-9]/.test(this.peek() || '')) fail()
      this.i++
    }
  }

  // Returns { text, base (for constructor names), ctorDtor?, conversion? }
  unqualifiedName(enclosing) {
    // GCC marks names with internal linkage with L; c++filt does not show it
    if (this.peek() === 'L' && /[0-9]/.test(this.peek(1) || '')) this.i++
    const c = this.peek()
    if (/[0-9]/.test(c || '')) {
      const id = this.sourceName()
      return { text: this.abiTags(id), base: id }
    }
    if (c === 'C' && /[1-5]/.test(this.peek(1) || '')) {
      if (!enclosing) fail()
      this.i += 2
      return { text: this.abiTags(enclosing), base: enclosing, ctorDtor: true }
    }
    if (c === 'D' && /[0-25]/.test(this.peek(1) || '')) {
      if (!enclosing) fail()
      this.i += 2
      return { text: this.abiTags(`~${enclosing}`), base: enclosing, ctorDtor: true }
    }
    if (c === 'U') {
      if (this.eat('Ut')) {
        const n = this.peek() === '_' ? 1 : this.number() + 2
        this.expect('_')
        const text = `{unnamed type#${n}}`
        return { text, base: text }
      }
      if (this.eat('Ul')) {
        const params = []
        while (this.peek() !== 'E') {
          if (this.i >= this.s.length) fail()
          params.push(this.type())
        }
        this.expect('E')
        const n = this.peek() === '_' ? 1 : this.number() + 2
        this.expect('_')
        const text = `{lambda(${paramList(params)})#${n}}`
        return { text, base: text }
      }
      return fail()
    }
    if (c === 'c' && this.peek(1) === 'v') {
      this.i += 2
      const type = this.type()
      if (containsTemplateParam(type)) fail()
      return { text: `operator ${typeText(type)}`, base: '', conversion: true }
    }
    if (c === 'l' && this.peek(1) === 'i') {
      this.i += 2
      const id = this.sourceName()
      return { text: `operator"" ${id}`, base: '' }
    }
    const op = OPERATORS[this.s.slice(this.i, this.i + 2)]
    if (op) {
      this.i += 2
      const text = /^[a-z]/.test(op) ? `operator ${op}` : `operator${op}`
      return { text: this.abiTags(text), base: '' }
    }
    return fail()
  }

  substitution() {
    this.expect('S')
    const c = this.peek()
    if (c && STD_ABBREVIATIONS[c] && /[a-z]/.test(c)) {
      this.i++
      const [text, last] = STD_ABBREVIATIONS[c]
      return { text, last }
    }
    const index = this.seqId()
    if (index >= this.subs.length) fail()
    const sub = this.subs[index]
    if (sub.kind !== 'name') fail()
    return { text: sub.text, last: lastComponent(sub.text) }
  }

  templateParam() {
    this.expect('T')
    const index = this.seqId()
    if (!this.templateArgs || index >= this.templateArgs.length) fail()
    const arg = this.templateArgs[index]
    return { kind: 'name', text: arg, param: true, argType: this.argTypes.get(arg) || null }
  }

  templateArgsList() {
    this.expect('I')
    const args = []
    while (!this.eat('E')) {
      if (this.i >= this.s.length) fail()
      args.push(this.templateArg())
    }
    if (!args.length) fail()
    return args
  }

  templateArg() {
    const c = this.peek()
    if (c === 'L') return this.literal()
    if (c === 'X' || c === 'J') fail()
    const type = this.type()
    const text = typeText(type)
    this.argTypes.set(text, type)
    return text
  }

  literal() {
    this.expect('L')
    if (this.peek() === '_' && this.peek(1) === 'Z') {
      this.i += 2
      const text = this.encoding(false)
      this.expect('E')
      return text
    }
    const c = this.peek()
    if (!/[a-z]/.test(c || '') || !BUILTINS[c] || c === 'v' || c === 'z') fail()
    this.i++
    const negative = this.eat('n')
    const start = this.i
    while (/[0-9]/.test(this.peek() || '')) this.i++
    if (start === this.i) fail()
    const digits = (negative ? '-' : '') + this.s.slice(start, this.i)
    this.expect('E')
    if (c === 'b') {
      if (digits === '0') return 'false'
      if (digits === '1') return 'true'
      return fail()
    }
    if (Object.hasOwn(LITERAL_SUFFIX, c)) return digits + LITERAL_SUFFIX[c]
    if ('fde'.includes(c)) fail()
    return `(${BUILTINS[c]})${digits}`
  }

  // ---------------------------------------------------------------- types
  type() {
    this.enter()
    try {
      return this.typeInner()
    } finally {
      this.depth--
    }
  }

  typeInner() {
    const c = this.peek()
    if (c === undefined) fail()
    if (BUILTINS[c]) {
      this.i++
      return named(BUILTINS[c])
    }
    if (c === 'u') {
      this.i++
      return named(this.sourceName())
    }
    if (c === 'D') {
      const d = this.peek(1)
      if (D_BUILTINS[d]) {
        this.i += 2
        return named(D_BUILTINS[d])
      }
      if (d === 'F') {
        this.i += 2
        const bits = this.number()
        this.expect('_')
        return named(`_Float${bits}`)
      }
      return fail() // decltype, pack expansions, vectors
    }
    if (c === 'r' || c === 'V' || c === 'K') {
      const quals = []
      while (/[rVK]/.test(this.peek() || '')) quals.push(this.s[this.i++])
      const inner = this.type()
      // Qualifying a template parameter that is itself qualified, a reference,
      // an array or a function collapses in ways not modelled here
      if (inner.param && (!inner.argType || inner.argType.kind !== 'name')) fail()
      const t = { kind: 'qual', quals: qualText(quals), inner }
      // A cv-qualified function type (a const member function) is not a candidate of its own
      if (!isFunc(inner)) this.subs.push(t)
      return t
    }
    if (c === 'P' || c === 'R' || c === 'O') {
      this.i++
      const inner = this.type()
      if (inner.param && (!inner.argType || !['name', 'qual', 'ptr'].includes(inner.argType.kind) ||
        (c !== 'P' && inner.argType.kind === 'ptr' && inner.argType.op !== '*'))) fail()
      const t = { kind: 'ptr', op: c === 'P' ? '*' : c === 'R' ? '&' : '&&', inner }
      if (inner.kind === 'qual' && isFunc(inner.inner)) fail()
      this.subs.push(t)
      return t
    }
    if (c === 'F') {
      this.i++
      if (this.eat('Y')) fail()
      const ret = this.type()
      const params = []
      while (this.peek() !== 'E') {
        if (this.i >= this.s.length) fail()
        if (this.peek() === 'R' && this.peek(1) === 'E') break
        if (this.peek() === 'O' && this.peek(1) === 'E') break
        params.push(this.type())
      }
      let ref = ''
      if (this.eat('R')) ref = ' &'
      else if (this.eat('O')) ref = ' &&'
      this.expect('E')
      if (!params.length || hasDeclarator(ret)) fail()
      const t = { kind: 'func', ret, params, ref }
      this.subs.push(t)
      return t
    }
    if (c === 'A') {
      this.i++
      let dim = ''
      if (/[0-9]/.test(this.peek() || '')) dim = String(this.number())
      else if (this.peek() !== '_') fail()
      this.expect('_')
      const inner = this.type()
      const t = { kind: 'array', dim, inner }
      this.subs.push(t)
      return t
    }
    if (c === 'M') {
      this.i++
      const cls = this.type()
      const member = this.type()
      const t = { kind: 'ptrmem', cls, member }
      this.subs.push(t)
      return t
    }
    if (c === 'T') {
      const t = this.templateParam()
      this.subs.push(t)
      if (this.peek() === 'I') {
        const args = this.templateArgsList()
        const full = named(withArgs(t.text, args))
        this.subs.push(full)
        return full
      }
      return t
    }
    if (c === 'S') {
      if (this.peek(1) === 't') {
        const n = this.name()
        const t = named(n.text)
        this.subs.push(t)
        return t
      }
      const sub = this.substitutionType()
      if (this.peek() === 'I') {
        const args = this.templateArgsList()
        const t = named(withArgs(sub.kind === 'name' ? sub.text : fail(), args))
        this.subs.push(t)
        return t
      }
      return sub
    }
    if (c === 'N' || c === 'Z' || /[0-9]/.test(c)) {
      const n = c === 'N' ? this.nestedName() : this.name()
      if (n.cv || n.ref || n.ctorDtor) fail()
      const t = named(n.text)
      this.subs.push(t)
      return t
    }
    return fail()
  }

  substitutionType() {
    this.expect('S')
    const c = this.peek()
    if (c && STD_ABBREVIATIONS[c] && /[a-z]/.test(c)) {
      this.i++
      return named(STD_ABBREVIATIONS[c][0])
    }
    const index = this.seqId()
    if (index >= this.subs.length) fail()
    return this.subs[index]
  }
}

// Types that wrap their declarator around the name, such as a pointer to a
// function: printing a function that returns one is not modelled
function hasDeclarator(t) {
  let inner = t
  while (inner.kind === 'qual' || inner.kind === 'ptr') inner = inner.inner
  return inner.kind === 'func' || inner.kind === 'array' || inner.kind === 'ptrmem'
}

function qualText(quals) {
  // Printed in the order const, volatile, restrict, as c++filt does
  const out = []
  if (quals.includes('K')) out.push('const')
  if (quals.includes('V')) out.push('volatile')
  if (quals.includes('r')) out.push('restrict')
  return out.join(' ')
}

function lastComponent(text) {
  let depth = 0
  for (let i = text.length - 1; i > 0; i--) {
    const ch = text[i]
    if (ch === '>') depth++
    else if (ch === '<') depth--
    else if (ch === ':' && text[i - 1] === ':' && depth === 0) return stripArgs(text.slice(i + 1))
  }
  return stripArgs(text)
}

function stripArgs(text) {
  const at = text.indexOf('<')
  return at > 0 ? text.slice(0, at) : text
}

function containsTemplateParam(t) {
  if (!t) return false
  if (t.param) return true
  return containsTemplateParam(t.inner) || containsTemplateParam(t.ret) || containsTemplateParam(t.cls) || containsTemplateParam(t.member) ||
    (t.params ? t.params.some(containsTemplateParam) : false)
}

// ---------------------------------------------------------------- Rust (legacy mangling)

const RUST_ESCAPES = { SP: '@', BP: '*', RF: '&', LT: '<', GT: '>', LP: '(', RP: ')', C: ',' }

function demangleRustLegacy(name) {
  if (!name.startsWith('_ZN') || !name.endsWith('E')) return null
  let i = 3
  const parts = []
  while (i < name.length - 1) {
    const match = /^[1-9][0-9]*/.exec(name.slice(i))
    if (!match) return null
    const length = Number(match[0])
    i += match[0].length
    if (i + length > name.length - 1) return null
    parts.push(name.slice(i, i + length))
    i += length
  }
  if (i !== name.length - 1 || parts.length < 2) return null
  const hash = parts.pop()
  if (!/^h[0-9a-f]{16}$/.test(hash)) return null
  const decoded = []
  for (const part of parts) {
    let out = ''
    let k = part.startsWith('_$') ? 1 : 0
    while (k < part.length) {
      if (part[k] === '$') {
        const end = part.indexOf('$', k + 1)
        if (end < 0) return null
        const code = part.slice(k + 1, end)
        if (RUST_ESCAPES[code]) out += RUST_ESCAPES[code]
        else if (/^u[0-9a-f]{1,6}$/.test(code)) {
          const cp = parseInt(code.slice(1), 16)
          if (cp > 0x10ffff || cp < 0x20) return null
          out += String.fromCodePoint(cp)
        } else return null
        k = end + 1
      } else if (part.startsWith('..', k)) {
        out += '::'
        k += 2
      } else {
        if (!/[A-Za-z0-9_.]/.test(part[k])) return null
        out += part[k]
        k++
      }
    }
    decoded.push(out)
  }
  // c++filt keeps the hash, which tells apart instances of the same path
  return [...decoded, hash].join('::')
}

/**
 * Demangled form of a symbol name, or null when the name is not mangled or
 * uses grammar this demangler does not cover.
 */
export function demangle(name) {
  if (typeof name !== 'string' || name.length > MAX_LENGTH || !name.startsWith('_Z')) return null
  const rust = demangleRustLegacy(name)
  if (rust) return rust
  try {
    return new Parser(name).mangled()
  } catch (err) {
    if (err instanceof Fail || err instanceof RangeError) return null
    throw err
  }
}
