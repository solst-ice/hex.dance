/** Renders text where `backticks` mark code. */
export function Rich({ text }) {
  const parts = String(text).split('`')
  return parts.map((part, index) => (index % 2 === 1
    ? <code key={index} className="ch-code">{part}</code>
    : part))
}
