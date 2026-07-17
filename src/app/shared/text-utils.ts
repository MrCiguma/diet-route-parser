export function sanitizeText(raw: string): string {
  // Strips bidi/formatting control chars (LRM, RLM, LRE..PDF) some clients paste in.
  return Array.from(raw || '')
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return !(code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e));
    })
    .join('')
    .replace(/\r\n/g, '\n');
}
