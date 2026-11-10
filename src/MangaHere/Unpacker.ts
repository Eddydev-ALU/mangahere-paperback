/**
 * MangaHere wraps some of its page scripts in the common "p,a,c,k,e,d" packer.
 * This undoes that packing without eval(), so it works inside Paperback.
 */

const PACKED_ARGS = /\}\s*\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:[^'\\]|\\.)*)'\.split\('\|'\)/

function encodeIndex(index: number, radix: number): string {
    const head = index < radix ? '' : encodeIndex(Math.floor(index / radix), radix)
    const rest = index % radix
    return head + (rest > 35 ? String.fromCharCode(rest + 29) : rest.toString(36))
}

export function isPacked(script: string): boolean {
    return PACKED_ARGS.test(script)
}

export function unpack(script: string): string {
    const match = PACKED_ARGS.exec(script)
    if (!match) throw new Error('MangaHere script is not in the expected packed format')

    const payload = (match[1] ?? '').replace(/\\'/g, "'").replace(/\\\\/g, '\\')
    const radix = Number(match[2])
    const count = Number(match[3])
    const words = (match[4] ?? '').split('|')

    const dictionary: Record<string, string> = {}
    for (let i = count - 1; i >= 0; i--) {
        const key = encodeIndex(i, radix)
        dictionary[key] = words[i] || key
    }

    return payload.replace(/\b\w+\b/g, (token) => dictionary[token] ?? token)
}

/** Returns every packed script found in an HTML page, unpacked. */
export function unpackAll(html: string): string[] {
    const results: string[] = []
    const marker = 'eval(function(p,a,c,k,e,d)'
    let start = html.indexOf(marker)
    while (start >= 0) {
        const end = html.indexOf('</script>', start)
        const chunk = html.substring(start, end < 0 ? undefined : end)
        try {
            results.push(unpack(chunk))
        } catch {
            // Not every match is a complete packed script; skip it.
        }
        start = html.indexOf(marker, start + marker.length)
    }
    return results
}
