// Sandbox policy placement in untrusted HTML (P06.10); extracted from viewer; must land in head (quirks/error-recovery risks).

export const REPORT_CSP =
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; "
  + "style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; "
  + "form-action 'none'; base-uri 'none'; frame-ancestors 'none'\">"

export function withPolicy(source: string, policy = REPORT_CSP): string {
  const head = /<head[^>]*>/i.exec(source)
  if (head) {
    const at = head.index + head[0].length
    return source.slice(0, at) + policy + source.slice(at)
  }
  const htmlTag = /<html[^>]*>/i.exec(source)
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length
    return `${source.slice(0, at)}<head>${policy}</head>${source.slice(at)}`
  }
  return policy + source
}
