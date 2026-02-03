import { SignJWT, importPKCS8 } from 'jose'

/**
 * Convert PKCS#1 (RSA PRIVATE KEY) to PKCS#8 (PRIVATE KEY) format
 * GitHub App keys are PKCS#1, but jose requires PKCS#8
 */
function convertPKCS1toPKCS8(pkcs1Pem: string): string {
    // If already PKCS#8, return as-is
    if (pkcs1Pem.includes('BEGIN PRIVATE KEY')) {
        return pkcs1Pem
    }

    // Extract base64 content from PKCS#1 PEM
    const base64 = pkcs1Pem
        .replace(/-----BEGIN RSA PRIVATE KEY-----/, '')
        .replace(/-----END RSA PRIVATE KEY-----/, '')
        .replace(/\s/g, '')

    // Decode PKCS#1 key
    const pkcs1Bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))

    // PKCS#8 wrapper for RSA keys (OID 1.2.840.113549.1.1.1)
    const pkcs8Header = new Uint8Array([
        0x30, 0x82, 0x00, 0x00, // SEQUENCE, length placeholder
        0x02, 0x01, 0x00, // INTEGER 0 (version)
        0x30, 0x0d, // SEQUENCE (algorithm identifier)
        0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, // OID rsaEncryption
        0x05, 0x00, // NULL
        0x04, 0x82, 0x00, 0x00, // OCTET STRING, length placeholder
    ])

    // Calculate lengths
    const totalLen = pkcs8Header.length - 4 + pkcs1Bytes.length
    const octetLen = pkcs1Bytes.length

    // Create PKCS#8 structure
    const pkcs8 = new Uint8Array(4 + totalLen)
    pkcs8.set(pkcs8Header)
    pkcs8.set(pkcs1Bytes, pkcs8Header.length)

    // Set lengths (big-endian)
    pkcs8[2] = (totalLen >> 8) & 0xff
    pkcs8[3] = totalLen & 0xff
    pkcs8[pkcs8Header.length - 2] = (octetLen >> 8) & 0xff
    pkcs8[pkcs8Header.length - 1] = octetLen & 0xff

    // Encode as PEM
    const b64 = btoa(String.fromCharCode(...pkcs8))
    const lines = b64.match(/.{1,64}/g) ?? []
    return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`
}

/**
 * Normalize PEM key - handle escaped newlines from env vars
 */
function normalizePEM(pem: string): string {
    // Replace literal \n with actual newlines
    return pem.replace(/\\n/g, '\n')
}

/**
 * Generate a JWT for GitHub App authentication
 */
async function generateAppJWT(appId: string, privateKey: string): Promise<string> {
    const normalizedKey = normalizePEM(privateKey)
    const pkcs8Key = convertPKCS1toPKCS8(normalizedKey)
    const key = await importPKCS8(pkcs8Key, 'RS256')
    const now = Math.floor(Date.now() / 1000)

    return new SignJWT({})
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuedAt(now - 60) // 1 min in past for clock drift
        .setExpirationTime(now + 600) // 10 min max
        .setIssuer(appId)
        .sign(key)
}

/**
 * Get an installation access token for a GitHub App
 * This token is short-lived (~1 hour) and scoped to the installation
 */
export async function getInstallationToken(
    appId: string,
    privateKey: string,
    installationId: number
): Promise<string> {
    const jwt = await generateAppJWT(appId, privateKey)

    const response = await fetch(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${jwt}`,
                Accept: 'application/vnd.github+json',
                'User-Agent': 'Koios OTA Updater',
            },
        }
    )

    if (!response.ok) {
        const text = await response.text()
        throw new Error(`Failed to get installation token: ${response.status} ${text}`)
    }

    const data = await response.json<{ token: string }>()
    return data.token
}
