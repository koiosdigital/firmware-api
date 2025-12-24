import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { projects } from './projects'
import type { FirmwareManifest, FirmwareUpdateResponse, GitHubRelease } from './types'
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

type Bindings = {}

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', cors())

app.onError((err, c) => {
  // Avoid leaking internals; still surface a helpful message.
  return jsonError(c, 500, err instanceof Error ? err.message : 'Internal error')
})

app.notFound((c) => jsonError(c, 404, 'Not found'))

function githubHeaders() {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Koios OTA Updater',
  } as const
}

async function fetchLatestRelease(repoSlug: string) {
  const res = await fetch(`https://api.github.com/repos/${repoSlug}/releases/latest`, {
    headers: githubHeaders(),
  })

  if (!res.ok) {
    return { ok: false as const, status: res.status, statusText: res.statusText }
  }

  let json: unknown
  try {
    json = await res.json()
  } catch {
    return { ok: false as const, status: 502, statusText: 'Invalid JSON from GitHub' }
  }

  const release = json as Partial<GitHubRelease>
  if (!release.tag_name || !Array.isArray(release.assets)) {
    return { ok: false as const, status: 502, statusText: 'Unexpected GitHub API response' }
  }

  return { ok: true as const, release: release as GitHubRelease }
}

//MARK: Firmware OTA
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

  const upstream = await fetchLatestRelease(project.repository_slug)
  if (!upstream.ok) {
    return jsonError(c, 502, `Error fetching data from GitHub: ${upstream.statusText}`)
  }

  const manifestAssets = upstream.release.assets.filter((a) => a.name.endsWith('_manifest.json'))
  const variants = manifestAssets.map((a) => a.name.replace('_manifest.json', ''))

  return c.json({
    name: project.name,
    repo: project.repository_slug,
    variants: variants,
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

  const upstream = await fetchLatestRelease(project.repository_slug)
  if (!upstream.ok) {
    return jsonError(c, 502, `Error fetching data from GitHub: ${upstream.statusText}`)
  }

  // Find the specific manifest file for this variant
  const manifestName = `${variant}_manifest.json`
  const manifestAsset = upstream.release.assets.find((a) => a.name === manifestName)

  if (!manifestAsset) {
    return jsonError(c, 404, `Variant ${variant} not found for project ${slug}`)
  }

  try {
    // Fetch the manifest file
    const manifestResponse = await fetch(manifestAsset.browser_download_url)
    if (!manifestResponse.ok) {
      return c.text(`Failed to fetch manifest for ${variant}: ${manifestResponse.statusText}`, 500)
    }

    const manifest = (await manifestResponse.json()) as FirmwareManifest

    // Rewrite all URLs in the manifest to be absolute
    const baseUrl = manifestAsset.browser_download_url.replace(manifestAsset.name, '')

    // Update parts URLs to be absolute
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
  } catch (error) {
    return jsonError(c, 500, `Error processing manifest for ${variant}`)
  }
})

app.get('/', async (c) => {
  const project = c.req.header('x-firmware-project')
  const currentVersion = c.req.header('x-firmware-version')
  let projectVariant = c.req.header('x-firmware-variant')
  const deviceMacAddress = c.req.header('x-device-mac-address')
  const deviceIdentity = c.req.header('x-device-identity')

  if (!project) return jsonError(c, 400, 'Missing x-firmware-project header')
  if (!currentVersion) return jsonError(c, 400, 'Missing x-firmware-version header')
  if (!isSafeIdentifier(project)) return jsonError(c, 400, 'Invalid x-firmware-project')
  if (!deviceMacAddress) {
    //return c.text('Missing x-device-mac-address header', 400)
  }
  if (!deviceIdentity) {
    //return c.text('Missing x-device-identity header', 400)
  }

  // Compatibility behavior: devices reporting 0.0.1 are considered up-to-date.
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

  const upstream = await fetchLatestRelease(projectData.repository_slug)
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

  // Find the appropriate manifest file
  let manifestName = "";
  if (projectData.supports_variants) {
    manifestName = `${projectVariant}_manifest.json`
  } else {
    manifestName = `default_manifest.json`
  }

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
    // Fetch and parse the manifest
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

    // Find the app binary in the manifest
    const baseUrl = manifestAsset.browser_download_url.replace(manifestAsset.name, '')
    let appBinaryUrl = null

    if (manifest.builds && Array.isArray(manifest.builds) && manifest.builds.length > 0) {
      const build = manifest.builds[0] // Take the first build
      if (build.parts && Array.isArray(build.parts)) {
        const normalizedSlug = projectData.slug.toLowerCase().replace(/-/g, '_')

        // Look for the app partition (includes project name, app, or firmware)
        const appPart = build.parts.find((part: any) => {
          if (!part.path) return false

          const normalizedPath = part.path.toLowerCase().replace(/-/g, '_')
          return normalizedPath.includes(normalizedSlug)
        })

        if (appPart) {
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
  } catch (error) {
    const response: FirmwareUpdateResponse = {
      error: true,
      update_available: false,
      error_message: 'Error processing manifest',
    }
    return c.json(response, 500)
  }
})

//for koios factory
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
    headers: {
      'User-Agent': 'Koios OTA Updater',
    },
  })
  if (!data.ok) {
    return jsonError(c, 502, `Error fetching data from URL: ${data.statusText}`)
  }

  const buffer = await data.arrayBuffer()

  //return file
  c.res.headers.set('Content-Type', 'application/octet-stream')
  const filename = sanitizeFilename(url.pathname)
  c.res.headers.set('Content-Disposition', `attachment; filename="${filename}"`)
  c.res.headers.set('Content-Length', buffer.byteLength.toString())
  c.res.headers.set('Cache-Control', 'no-store')

  return c.body(buffer, 200)
})

//MARK: Timezone
app.get('/tz', async (c) => {
  const clientIP = c.req.header("Cf-Connecting-IP");
  if (!clientIP || !isValidIpAddress(clientIP)) return jsonError(c, 400, 'Missing/invalid client IP')

  const tzinfo = await fetch(`https://api.ipquery.io/${clientIP}`)

  if (!tzinfo.ok) {
    return jsonError(c, 502, 'Failed to resolve timezone')
  }

  const json = (await tzinfo.json()) as any;


  //geolocate
  return c.json({
    tzname: json.location.timezone as string
  })
})

export default app
