import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { projects } from './projects'
import type {
    CoredumpRequest,
    Env,
    FirmwareManifest,
    FirmwareUpdateResponse,
    GitHubRelease,
    GitHubWebhookPayload,
} from './types'
import { buildOpenApiDocument } from './openapi'
import {
    compareSemver,
    isSafeIdentifier,
    isValidIpAddress,
    jsonError,
    parseSemver,
    safeDecodeURIComponent,
    sanitizeFilename,
} from './utils'
import { getCachedRelease, invalidateCache, setCachedRelease } from './cache'
import { verifyGitHubSignature } from './crypto'
import { getFirmware, syncReleaseToR2 } from './storage'
import { buildElfDownloadUrl, parseCoredump } from './coredump'

const app = new Hono<{ Bindings: Env }>()

app.use('*', cors())

app.onError((err, c) => {
    return jsonError(c, 500, err instanceof Error ? err.message : 'Internal error')
})

app.notFound((c) => jsonError(c, 404, 'Not found'))

function githubHeaders(): Record<string, string> {
    return {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Koios OTA Updater',
    }
}

type FetchReleaseSuccess = { ok: true; release: GitHubRelease }
type FetchReleaseError = { ok: false; status: number; statusText: string }
type FetchReleaseResult = FetchReleaseSuccess | FetchReleaseError

async function fetchLatestRelease(
    repoSlug: string,
    cache?: KVNamespace
): Promise<FetchReleaseResult> {
    // Try cache first
    if (cache) {
        const cached = await getCachedRelease(cache, repoSlug)
        if (cached) {
            return { ok: true, release: cached }
        }
    }

    const res = await fetch(`https://api.github.com/repos/${repoSlug}/releases/latest`, {
        headers: githubHeaders(),
    })

    if (!res.ok) {
        return { ok: false, status: res.status, statusText: res.statusText }
    }

    let json: unknown
    try {
        json = await res.json()
    } catch {
        return { ok: false, status: 502, statusText: 'Invalid JSON from GitHub' }
    }

    const release = json as Partial<GitHubRelease>
    if (!release.tag_name || !Array.isArray(release.assets)) {
        return { ok: false, status: 502, statusText: 'Unexpected GitHub API response' }
    }

    const validatedRelease = release as GitHubRelease

    // Store in cache
    if (cache) {
        await setCachedRelease(cache, repoSlug, validatedRelease)
    }

    return { ok: true, release: validatedRelease }
}

// MARK: - Projects

app.get('/projects', (c) => {
    return c.json(projects)
})

app.get('/swagger.json', (c) => {
    return c.json(buildOpenApiDocument({ projects }), 200)
})

app.get('/projects/:slug', async (c) => {
    const slug = c.req.param('slug')
    if (!isSafeIdentifier(slug)) {
        return jsonError(c, 400, 'Invalid project slug')
    }
    const project = projects.find((p) => p.slug === slug)
    if (!project) {
        return jsonError(c, 404, `Project ${slug} not found`)
    }

    const upstream = await fetchLatestRelease(project.repository_slug, c.env.CACHE)
    if (!upstream.ok) {
        return jsonError(c, 502, `Error fetching data from GitHub: ${upstream.statusText}`)
    }

    const manifestAssets = upstream.release.assets.filter((a) => a.name.endsWith('_manifest.json'))
    const variants = manifestAssets.map((a) => a.name.replace('_manifest.json', ''))

    return c.json({
        name: project.name,
        repo: project.repository_slug,
        variants,
    })
})

app.get('/projects/:slug/:variant', async (c) => {
    const slug = c.req.param('slug')
    const variant = c.req.param('variant')
    if (!isSafeIdentifier(slug)) {
        return jsonError(c, 400, 'Invalid project slug')
    }
    if (!isSafeIdentifier(variant)) {
        return jsonError(c, 400, 'Invalid variant')
    }
    const project = projects.find((p) => p.slug === slug)
    if (!project) {
        return jsonError(c, 404, `Project ${slug} not found`)
    }

    const upstream = await fetchLatestRelease(project.repository_slug, c.env.CACHE)
    if (!upstream.ok) {
        return jsonError(c, 502, `Error fetching data from GitHub: ${upstream.statusText}`)
    }

    const manifestName = `${variant}_manifest.json`
    const manifestAsset = upstream.release.assets.find((a) => a.name === manifestName)

    if (!manifestAsset) {
        return jsonError(c, 404, `Variant ${variant} not found for project ${slug}`)
    }

    try {
        const manifestResponse = await fetch(manifestAsset.browser_download_url)
        if (!manifestResponse.ok) {
            return jsonError(c, 500, `Failed to fetch manifest for ${variant}: ${manifestResponse.statusText}`)
        }

        const manifest = (await manifestResponse.json()) as FirmwareManifest
        const baseUrl = manifestAsset.browser_download_url.replace(manifestAsset.name, '')

        // Rewrite URLs to absolute
        if (manifest.builds && Array.isArray(manifest.builds)) {
            manifest.builds = manifest.builds.map((build) => {
                if (!build || typeof build !== 'object') return build
                if (!Array.isArray(build.parts)) return build
                return {
                    ...build,
                    parts: build.parts.map((part) => {
                        if (!part || typeof part !== 'object') return part
                        const path = typeof part.path === 'string' ? part.path : undefined
                        return {
                            ...part,
                            path: path ? baseUrl + path : path,
                        }
                    }),
                }
            })
        }

        return c.json(manifest)
    } catch {
        return jsonError(c, 500, `Error processing manifest for ${variant}`)
    }
})

// MARK: - OTA Update Check

app.get('/', async (c) => {
    const project = c.req.header('x-firmware-project')
    const currentVersion = c.req.header('x-firmware-version')
    const projectVariant = c.req.header('x-firmware-variant')

    if (!project) return jsonError(c, 400, 'Missing x-firmware-project header')
    if (!currentVersion) return jsonError(c, 400, 'Missing x-firmware-version header')
    if (!isSafeIdentifier(project)) return jsonError(c, 400, 'Invalid x-firmware-project')

    // Compatibility: devices reporting 0.0.1 are considered up-to-date
    if (currentVersion.trim() === '0.0.1') {
        const response: FirmwareUpdateResponse = { error: false, update_available: false }
        return c.json(response)
    }

    const projectData = projects.find((p) => p.slug === project)
    if (!projectData) {
        return jsonError(c, 404, `Project ${project} not found`)
    }

    if (projectData.supports_variants && !projectVariant) {
        return jsonError(c, 400, 'Missing x-firmware-variant header')
    }
    if (projectVariant && !isSafeIdentifier(projectVariant)) {
        return jsonError(c, 400, 'Invalid x-firmware-variant')
    }

    const current = parseSemver(currentVersion)
    if (!current) return jsonError(c, 400, 'Invalid x-firmware-version (expected semver)')

    const upstream = await fetchLatestRelease(projectData.repository_slug, c.env.CACHE)
    if (!upstream.ok) {
        return jsonError(c, 502, `Error fetching data from GitHub: ${upstream.statusText}`)
    }

    const latest = parseSemver(upstream.release.tag_name)
    if (!latest) return jsonError(c, 502, 'Invalid tag_name from GitHub')

    const hasUpdate = compareSemver(current, latest) < 0

    if (!hasUpdate) {
        const response: FirmwareUpdateResponse = { error: false, update_available: false }
        return c.json(response)
    }

    const manifestName = projectData.supports_variants
        ? `${projectVariant}_manifest.json`
        : 'default_manifest.json'

    const manifestAsset = upstream.release.assets.find((a) => a.name === manifestName)
    if (!manifestAsset) {
        const response: FirmwareUpdateResponse = {
            error: true,
            update_available: false,
            error_message: `No manifest found for ${manifestName} in release ${upstream.release.tag_name}`,
        }
        return c.json(response, 502)
    }

    try {
        const manifestResponse = await fetch(manifestAsset.browser_download_url)
        if (!manifestResponse.ok) {
            const response: FirmwareUpdateResponse = {
                error: true,
                update_available: false,
                error_message: `Failed to fetch manifest: ${manifestResponse.statusText}`,
            }
            return c.json(response, 502)
        }

        const manifest = (await manifestResponse.json()) as FirmwareManifest
        const baseUrl = manifestAsset.browser_download_url.replace(manifestAsset.name, '')
        let appBinaryUrl: string | null = null

        if (manifest.builds && Array.isArray(manifest.builds) && manifest.builds.length > 0) {
            const build = manifest.builds[0]
            if (build?.parts && Array.isArray(build.parts)) {
                const normalizedSlug = projectData.slug.toLowerCase().replace(/-/g, '_')
                const appPart = build.parts.find((part) => {
                    if (!part?.path) return false
                    const normalizedPath = part.path.toLowerCase().replace(/-/g, '_')
                    return normalizedPath.includes(normalizedSlug)
                })

                if (appPart?.path) {
                    appBinaryUrl = baseUrl + appPart.path
                }
            }
        }

        if (!appBinaryUrl) {
            const response: FirmwareUpdateResponse = {
                error: true,
                update_available: false,
                error_message: `No app binary found in manifest for ${manifestName}`,
            }
            return c.json(response, 502)
        }

        const response: FirmwareUpdateResponse = {
            error: false,
            update_available: true,
            ota_url: appBinaryUrl,
        }
        return c.json(response)
    } catch {
        const response: FirmwareUpdateResponse = {
            error: true,
            update_available: false,
            error_message: 'Error processing manifest',
        }
        return c.json(response, 500)
    }
})

// MARK: - GitHub Mirror

app.get('/mirror/:encodedURL', async (c) => {
    const encodedURL = c.req.param('encodedURL')
    const decoded = safeDecodeURIComponent(encodedURL)
    if (!decoded.ok) return jsonError(c, 400, 'Invalid encodedURL')

    let url: URL
    try {
        url = new URL(decoded.value)
    } catch {
        return jsonError(c, 400, 'Invalid URL')
    }

    if (url.protocol !== 'https:') return jsonError(c, 400, 'Only https URLs are allowed')
    if (url.username || url.password) return jsonError(c, 400, 'Credentials in URL are not allowed')

    const allowedHosts = new Set([
        'github.com',
        'objects.githubusercontent.com',
        'release-assets.githubusercontent.com',
        'github-releases.githubusercontent.com',
        'raw.githubusercontent.com',
    ])
    if (!allowedHosts.has(url.hostname)) return jsonError(c, 403, 'Host not allowed')

    const data = await fetch(url.toString(), {
        headers: { 'User-Agent': 'Koios OTA Updater' },
    })
    if (!data.ok) {
        return jsonError(c, 502, `Error fetching data from URL: ${data.statusText}`)
    }

    const buffer = await data.arrayBuffer()

    return new Response(buffer, {
        status: 200,
        headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${sanitizeFilename(url.pathname)}"`,
            'Content-Length': buffer.byteLength.toString(),
            'Cache-Control': 'no-store',
        },
    })
})

// MARK: - Timezone

app.get('/tz', async (c) => {
    const clientIP = c.req.header('Cf-Connecting-IP')
    if (!clientIP || !isValidIpAddress(clientIP)) {
        return jsonError(c, 400, 'Missing/invalid client IP')
    }

    const tzinfo = await fetch(`https://api.ipquery.io/${clientIP}`)
    if (!tzinfo.ok) {
        return jsonError(c, 502, 'Failed to resolve timezone')
    }

    const json = (await tzinfo.json()) as { location?: { timezone?: string } }

    return c.json({
        tzname: json.location?.timezone ?? 'UTC',
    })
})

// MARK: - R2 Firmware Storage

app.get('/firmware/:project/:variant/:version/:filename', async (c) => {
    const { project, variant, version, filename } = c.req.param()

    if (!isSafeIdentifier(project)) return jsonError(c, 400, 'Invalid project')
    if (!isSafeIdentifier(variant)) return jsonError(c, 400, 'Invalid variant')
    if (!isSafeIdentifier(version, { maxLen: 32 })) return jsonError(c, 400, 'Invalid version')
    if (!isSafeIdentifier(filename, { maxLen: 128 })) return jsonError(c, 400, 'Invalid filename')

    const object = await getFirmware(c.env.FIRMWARE, project, variant, version, filename)
    if (!object) {
        return jsonError(c, 404, 'Firmware not found')
    }

    const headers = new Headers()
    headers.set('Content-Type', object.httpMetadata?.contentType ?? 'application/octet-stream')
    headers.set('Content-Length', object.size.toString())
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    headers.set('ETag', object.httpEtag)

    return new Response(object.body, { headers })
})

// MARK: - GitHub Webhook

app.post('/webhook/github', async (c) => {
    const signature = c.req.header('X-Hub-Signature-256')
    if (!signature) {
        return jsonError(c, 401, 'Missing signature')
    }

    const payload = await c.req.text()

    const isValid = await verifyGitHubSignature(
        payload,
        signature,
        c.env.GITHUB_WEBHOOK_SECRET
    )

    if (!isValid) {
        return jsonError(c, 401, 'Invalid signature')
    }

    let webhookPayload: GitHubWebhookPayload
    try {
        webhookPayload = JSON.parse(payload) as GitHubWebhookPayload
    } catch {
        return jsonError(c, 400, 'Invalid JSON payload')
    }

    // Only process release.published events
    if (webhookPayload.action !== 'published' || !webhookPayload.release) {
        return c.json({ message: 'Event ignored' }, 200)
    }

    const repoFullName = webhookPayload.repository?.full_name
    if (!repoFullName) {
        return jsonError(c, 400, 'Missing repository name')
    }

    // Find the project by repository
    const project = projects.find((p) => p.repository_slug === repoFullName)
    if (!project) {
        return c.json({ message: 'Repository not configured' }, 200)
    }

    // Invalidate cache for this repository
    await invalidateCache(c.env.CACHE, project.repository_slug)

    // Sync release assets to R2
    const result = await syncReleaseToR2(
        c.env.FIRMWARE,
        project.slug,
        webhookPayload.release
    )

    return c.json({
        message: 'Release processed',
        project: project.slug,
        version: webhookPayload.release.tag_name,
        stored: result.stored,
        errors: result.errors,
    })
})

// MARK: - Coredump Analysis

app.post('/coredump', async (c) => {
    let body: CoredumpRequest
    try {
        body = await c.req.json<CoredumpRequest>()
    } catch {
        return jsonError(c, 400, 'Invalid JSON body')
    }

    const { project, variant, version, coredump } = body

    if (!project || !isSafeIdentifier(project)) {
        return jsonError(c, 400, 'Invalid project')
    }
    if (!variant || !isSafeIdentifier(variant)) {
        return jsonError(c, 400, 'Invalid variant')
    }
    if (!version || !isSafeIdentifier(version, { maxLen: 32 })) {
        return jsonError(c, 400, 'Invalid version')
    }
    if (!coredump || typeof coredump !== 'string') {
        return jsonError(c, 400, 'Missing coredump data')
    }

    const projectData = projects.find((p) => p.slug === project)
    if (!projectData) {
        return jsonError(c, 404, `Project ${project} not found`)
    }

    const result = parseCoredump(coredump)

    // Add ELF download URL for local decoding
    if (result.success) {
        result.elf_download_url = buildElfDownloadUrl(
            projectData.repository_slug,
            version,
            variant
        )
    }

    return c.json(result)
})

export default app
