/**
 * Built-in sample files in public/samples. Each one is small and was made
 * for teaching: see the `about` line for what to look for.
 * @typedef {{ id: string, label: string, file: string, type: string, about: string }} Sample
 * @type {Sample[]}
 */
export const SAMPLES = [
  { id: 'png', label: 'PNG', file: 'sample.png', type: 'image/png', about: '64×32 image with Title, Author and Comment text chunks' },
  { id: 'zip', label: 'ZIP', file: 'sample.zip', type: 'application/zip', about: 'Archive with a folder, stored and deflated entries and a comment' },
  { id: 'pdf', label: 'PDF', file: 'sample.pdf', type: 'application/pdf', about: 'One-page document with a title and author' },
  { id: 'elf', label: 'ELF', file: 'hello.elf', type: 'application/x-executable', about: 'Linux x86-64 program built from a few lines of C, symbols kept' },
  { id: 'pe', label: 'PE', file: 'hello.exe', type: 'application/vnd.microsoft.portable-executable', about: 'Windows x64 program with imports from kernel32 and two exports' },
  { id: 'macho', label: 'Mach-O', file: 'hello.macho', type: 'application/x-mach-binary', about: 'macOS x86-64 program with symbols' }
]

/**
 * Fetches a sample from this site and wraps it in a File.
 * @param {Sample} sample
 * @param {string} [base]
 * @returns {Promise<File>}
 */
export async function fetchSample(sample, base = '/') {
  const response = await fetch(`${base}samples/${sample.file}`)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const blob = await response.blob()
  return new File([blob], sample.file, { type: sample.type })
}
