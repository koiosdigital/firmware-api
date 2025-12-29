/**
 * Verify GitHub webhook signature (X-Hub-Signature-256)
 * Uses HMAC-SHA256 with the webhook secret
 */
export async function verifyGitHubSignature(
    payload: string,
    signature: string,
    secret: string
): Promise<boolean> {
    if (!signature.startsWith('sha256=')) {
        return false
    }

    const expectedSignature = signature.slice(7) // Remove 'sha256=' prefix

    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    )

    const signatureBytes = await crypto.subtle.sign(
        'HMAC',
        key,
        encoder.encode(payload)
    )

    const computedSignature = arrayBufferToHex(signatureBytes)

    // Constant-time comparison to prevent timing attacks
    return timingSafeEqual(computedSignature, expectedSignature)
}

function arrayBufferToHex(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer)
    let hex = ''
    for (const byte of bytes) {
        hex += byte.toString(16).padStart(2, '0')
    }
    return hex
}

function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) {
        return false
    }

    let result = 0
    for (let i = 0; i < a.length; i++) {
        result |= a.charCodeAt(i) ^ b.charCodeAt(i)
    }
    return result === 0
}
