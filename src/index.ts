import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type {
    CoredumpRequest,
    Env,
    FirmwareUpdateResponse,
    GitHubWebhookPayload,
} from './types'
import { buildOpenApiDocument } from './openapi'
import {
    compareSemver,
    isSafeIdentifier,
    isValidIpAddress,
    jsonError,
    parseSemver,
} from './utils'
import { verifyGitHubSignature } from './crypto'
import { getFirmware, getManifest, syncReleaseToR2 } from './storage'
import { parseCoredump } from './coredump'
import {
    getAllProjects,
    getProjectBySlug,
    upsertProject,
    getVariants,
    getLatestVersion,
} from './db'

const R2_PUBLIC_URL = 'https://otafiles.koiosdigital.net'

const app = new Hono<{ Bindings: Env }>()

app.use('*', cors())

app.onError((err, c) => {
    return jsonError(c, 500, err instanceof Error ? err.message : 'Internal error')
})

app.notFound((c) => jsonError(c, 404, 'Not found'))

// MARK: - Projects

app.get('/projects', async (c) => {
    const projects = await getAllProjects(c.env.DB)
    return c.json(projects)
})

app.get('/swagger.json', async (c) => {
    const projects = await getAllProjects(c.env.DB)
    return c.json(buildOpenApiDocument({ projects }), 200)
})

app.get('/projects/:slug', async (c) => {
    const slug = c.req.param('slug')
    if (!isSafeIdentifier(slug)) {
        return jsonError(c, 400, 'Invalid project slug')
    }
    const project = await getProjectBySlug(c.env.DB, slug)
    if (!project) {
        return jsonError(c, 404, `Project ${slug} not found`)
    }

    const variants = await getVariants(c.env.DB, slug)

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
    const project = await getProjectBySlug(c.env.DB, slug)
    if (!project) {
        return jsonError(c, 404, `Project ${slug} not found`)
    }

    const latestVersion = await getLatestVersion(c.env.DB, slug, variant)
    if (!latestVersion) {
        return jsonError(c, 404, `No releases found for variant ${variant}`)
    }

    const manifest = await getManifest(c.env.FIRMWARE, slug, variant, latestVersion)
    if (!manifest) {
        return jsonError(c, 404, `Manifest not found for ${variant}`)
    }

    // Rewrite URLs to absolute R2 public URLs
    if (manifest.builds && Array.isArray(manifest.builds)) {
        const baseUrl = `${R2_PUBLIC_URL}/firmware/${slug}/${variant}/${latestVersion}/`
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
})

// MARK: - OTA Update Check

app.get('/', async (c) => {
    const projectSlug = c.req.header('x-firmware-project')
    const currentVersion = c.req.header('x-firmware-version')
    const projectVariant = c.req.header('x-firmware-variant')

    if (!projectSlug) return jsonError(c, 400, 'Missing x-firmware-project header')
    if (!currentVersion) return jsonError(c, 400, 'Missing x-firmware-version header')
    if (!isSafeIdentifier(projectSlug)) return jsonError(c, 400, 'Invalid x-firmware-project')

    // Compatibility: devices reporting 0.0.1 are considered up-to-date
    if (currentVersion.trim() === '0.0.1') {
        const response: FirmwareUpdateResponse = { error: false, update_available: false }
        return c.json(response)
    }

    const project = await getProjectBySlug(c.env.DB, projectSlug)
    if (!project) {
        return jsonError(c, 404, `Project ${projectSlug} not found`)
    }

    // Variant is required if provided, but we don't enforce it based on project config anymore
    if (projectVariant && !isSafeIdentifier(projectVariant)) {
        return jsonError(c, 400, 'Invalid x-firmware-variant')
    }

    const current = parseSemver(currentVersion)
    if (!current) return jsonError(c, 400, 'Invalid x-firmware-version (expected semver)')

    const variant = projectVariant ?? 'default'
    const latestVersion = await getLatestVersion(c.env.DB, projectSlug, variant)

    if (!latestVersion) {
        const response: FirmwareUpdateResponse = {
            error: true,
            update_available: false,
            error_message: `No releases found for ${projectSlug}/${variant}`,
        }
        return c.json(response, 404)
    }

    const latest = parseSemver(latestVersion)
    if (!latest) {
        const response: FirmwareUpdateResponse = {
            error: true,
            update_available: false,
            error_message: 'Invalid version in storage',
        }
        return c.json(response, 500)
    }

    const hasUpdate = compareSemver(current, latest) < 0

    if (!hasUpdate) {
        const response: FirmwareUpdateResponse = { error: false, update_available: false }
        return c.json(response)
    }

    const manifest = await getManifest(c.env.FIRMWARE, projectSlug, variant, latestVersion)
    if (!manifest) {
        const response: FirmwareUpdateResponse = {
            error: true,
            update_available: false,
            error_message: `No manifest found for ${projectSlug}/${variant}/${latestVersion}`,
        }
        return c.json(response, 502)
    }

    let appBinaryUrl: string | null = null
    const baseUrl = `${R2_PUBLIC_URL}/firmware/${projectSlug}/${variant}/${latestVersion}/`

    if (manifest.builds && Array.isArray(manifest.builds) && manifest.builds.length > 0) {
        const build = manifest.builds[0]
        if (build?.parts && Array.isArray(build.parts)) {
            const normalizedSlug = projectSlug.toLowerCase().replace(/-/g, '_')
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
            error_message: `No app binary found in manifest for ${variant}`,
        }
        return c.json(response, 502)
    }

    const response: FirmwareUpdateResponse = {
        error: false,
        update_available: true,
        ota_url: appBinaryUrl,
    }
    return c.json(response)
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

    // Derive project name from release name or repository name
    // e.g., "koiosdigital/matrx-fw" -> "MATRX" (from release name) or "matrx-fw" (fallback)
    const releaseName = webhookPayload.release.name
    const repoName = repoFullName.split('/').pop() ?? repoFullName
    const projectName = releaseName || repoName.replace(/-fw$/, '').toUpperCase()

    // Upsert the project (create if new, update timestamp if exists)
    const project = await upsertProject(c.env.DB, repoFullName, projectName)

    // Sync release assets to R2 and record in D1
    const result = await syncReleaseToR2(
        c.env.FIRMWARE,
        c.env.DB,
        project.id,
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

    const projectData = await getProjectBySlug(c.env.DB, project)
    if (!projectData) {
        return jsonError(c, 404, `Project ${project} not found`)
    }

    const result = parseCoredump(coredump)

    // Add ELF download URL for local decoding (from R2)
    if (result.success) {
        result.elf_download_url = `${R2_PUBLIC_URL}/firmware/${project}/${variant}/${version}/${variant}.elf`
    }

    return c.json(result)
})

export default app
