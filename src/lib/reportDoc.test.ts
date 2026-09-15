import { describe, expect, it } from 'vitest'
import { REPORT_CSP, withPolicy } from './reportDoc'

// P06.10: real 1.6 MB report with 11 inline scripts and wowhead links; sandbox primary boundary, CSP secondary (lands in head).

const REAL_SHAPE = '<!DOCTYPE html>\n\n<html>\n<head>\n<title>Simulationcraft Results</title>\n'
  + '<style>body{}</style>\n</head>\n<body><script>x()</script><a href="https://www.wowhead.com/item=1">i</a></body></html>'

describe('withPolicy', () => {
  it('inserts inside <head>, after the doctype', () => {
    const out = withPolicy(REAL_SHAPE)
    expect(out.indexOf('<!DOCTYPE html>')).toBe(0)
    // Quirks mode if meta precedes doctype.
    expect(out.indexOf(REPORT_CSP)).toBeGreaterThan(out.indexOf('<head>'))
    expect(out.indexOf(REPORT_CSP)).toBeLessThan(out.indexOf('<title>'))
  })

  it('never lands inside the doctype, which a naive first-">" search would', () => {
    const out = withPolicy(REAL_SHAPE)
    const doctype = out.slice(0, out.indexOf('>') + 1)
    expect(doctype).toBe('<!DOCTYPE html>')
    expect(doctype).not.toContain('Content-Security-Policy')
  })

  it('loses nothing from the original document', () => {
    const out = withPolicy(REAL_SHAPE)
    for (const fragment of ['<title>Simulationcraft Results</title>', '<script>x()</script>', 'wowhead.com/item=1']) {
      expect(out).toContain(fragment)
    }
    expect(out.length).toBe(REAL_SHAPE.length + REPORT_CSP.length)
  })

  it('handles a head with attributes', () => {
    const out = withPolicy('<!DOCTYPE html><html><head lang="en"><title>t</title></head></html>')
    expect(out).toContain('<head lang="en">' + REPORT_CSP)
  })

  it('builds a head when the document has none', () => {
    const out = withPolicy('<html><body>no head</body></html>')
    expect(out).toContain('<html><head>' + REPORT_CSP + '</head>')
  })

  it('still applies a policy to a fragment with no html element', () => {
    // The sandbox is the real boundary; this is belt and braces for a document
    // that is not the shape we expect.
    expect(withPolicy('<p>fragment</p>').startsWith(REPORT_CSP)).toBe(true)
  })

  it('denies by default and permits only what the report genuinely needs', () => {
    expect(REPORT_CSP).toContain("default-src 'none'")
    // Inline styles and data: images keep the report readable; everything that
    // could reach the network or navigate is off.
    expect(REPORT_CSP).toContain("style-src 'unsafe-inline'")
    expect(REPORT_CSP).toContain("img-src data:")
    expect(REPORT_CSP).toContain("connect-src 'none'")
    expect(REPORT_CSP).toContain("form-action 'none'")
    expect(REPORT_CSP).toContain("base-uri 'none'")
    // script-src is NOT granted, and must not be: the report carries 11 inline
    // scripts built from profile text the user pasted.
    expect(REPORT_CSP).not.toContain('script-src')
  })
})
