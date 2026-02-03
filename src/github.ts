import { SignJWT, importPKCS8 } from 'jose'

/**
 * Generate a JWT for GitHub App authentication
 */
async function generateAppJWT(appId: string, privateKey: string): Promise<string> {
    const key = await importPKCS8(privateKey, 'RS256')
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
