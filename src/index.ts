import { Hono } from 'hono'
import { projects } from './projects'
import { cors } from 'hono/cors';

const app = new Hono()

//cors
app.use("*", cors());

//MARK: Firmware OTA
app.get('/projects', (c) => {
  return c.json(projects)
})

app.get('/projects/:slug', async (c) => {
  const slug = c.req.param('slug')
  const project = projects.find((p) => p.slug === slug)
  if (!project) {
    return c.text(`Project ${slug} not found`, 404)
  }

  //Fetch the latest release from GitHub
  const data = await fetch(`https://api.github.com/repos/${project.repository_slug}/releases/latest`, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Koios OTA Updater',
    }
  })

  if (!data.ok) {
    return c.text(`Error fetching data from GitHub: ${data.statusText}`, 500)
  }

  const json = await data.json() as any

  // Find manifest files and extract variant names
  const manifestAssets = json.assets.filter((a: any) => a.name.endsWith('_manifest.json'))
  const variants = manifestAssets.map((a: any) => a.name.replace('_manifest.json', ''))

  return c.json({
    name: project.name,
    repo: project.repository_slug,
    variants: variants,
  })
})

app.get('/projects/:slug/:variant', async (c) => {
  const slug = c.req.param('slug')
  const variant = c.req.param('variant')
  const project = projects.find((p) => p.slug === slug)
  if (!project) {
    return c.text(`Project ${slug} not found`, 404)
  }

  //Fetch the latest release from GitHub
  const data = await fetch(`https://api.github.com/repos/${project.repository_slug}/releases/latest`, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Koios OTA Updater',
    }
  })

  if (!data.ok) {
    return c.text(`Error fetching data from GitHub: ${data.statusText}`, 500)
  }

  const json = await data.json() as any

  // Find the specific manifest file for this variant
  const manifestName = `${variant}_manifest.json`
  const manifestAsset = json.assets.find((a: any) => a.name === manifestName)

  if (!manifestAsset) {
    return c.text(`Variant ${variant} not found for project ${slug}`, 404)
  }

  try {
    // Fetch the manifest file
    const manifestResponse = await fetch(manifestAsset.browser_download_url)
    if (!manifestResponse.ok) {
      return c.text(`Failed to fetch manifest for ${variant}: ${manifestResponse.statusText}`, 500)
    }

    const manifest = await manifestResponse.json() as any

    // Rewrite all URLs in the manifest to be absolute
    const baseUrl = manifestAsset.browser_download_url.replace(manifestAsset.name, '')

    // Update parts URLs to be absolute
    if (manifest.builds && Array.isArray(manifest.builds)) {
      manifest.builds = manifest.builds.map((build: any) => {
        if (build.parts && Array.isArray(build.parts)) {
          build.parts = build.parts.map((part: any) => ({
            ...part,
            path: baseUrl + part.path
          }))
        }
        return build
      })
    }

    return c.json(manifest)
  } catch (error) {
    return c.text(`Error processing manifest for ${variant}: ${error}`, 500)
  }
})

app.get('/', async (c) => {
  const project = c.req.header('x-firmware-project')
  const currentVersion = c.req.header('x-firmware-version')
  let projectVariant = c.req.header('x-firmware-variant')
  const deviceMacAddress = c.req.header('x-device-mac-address')
  const deviceIdentity = c.req.header('x-device-identity')

  if (!project) {
    return c.text('Missing x-firmware-project header', 400)
  }
  if (!currentVersion) {
    return c.text('Missing x-firmware-version header', 400)
  }
  if (!deviceMacAddress) {
    //return c.text('Missing x-device-mac-address header', 400)
  }
  if (!deviceIdentity) {
    //return c.text('Missing x-device-identity header', 400)
  }

  const projectData = projects.find((p) => p.slug === project)
  if (!projectData) {
    return c.text(`Project ${project} not found`, 404)
  }

  if (projectData.supports_variants && !projectVariant) {
    return c.text('Missing x-firmware-variant header', 400)
  }

  const data = await fetch(`https://api.github.com/repos/${projectData.repository_slug}/releases/latest`, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Koios OTA Updater',
    }
  })

  if (!data.ok) {
    return c.text(`Error fetching data from GitHub: ${data.statusText}`, 500)
  }

  const json = await data.json() as any
  const version = json.tag_name.replace('v', '')

  //semver comparison
  const currentVersionParts = currentVersion.split('.')
  const versionParts = version.split('.')

  var hasUpdate = false
  for (let i = 0; i < Math.max(currentVersionParts.length, versionParts.length); i++) {
    const currentPart = parseInt(currentVersionParts[i] || '0', 10)
    const newPart = parseInt(versionParts[i] || '0', 10)

    if (currentPart < newPart) {
      hasUpdate = true
      break
    }
  }

  if (!hasUpdate) {
    return c.json({
      error: false,
      update_available: false
    })
  }

  // Find the appropriate manifest file
  let manifestName = "";
  if (projectData.supports_variants) {
    manifestName = `${projectVariant}_manifest.json`
  } else {
    manifestName = `default_manifest.json`
  }

  const manifestAsset = json.assets.find((a: any) => a.name === manifestName)
  if (!manifestAsset) {
    return c.json({
      error: true,
      update_available: false,
      error_message: `No manifest found for ${manifestName} in release ${json.tag_name}`,
    })
  }

  try {
    // Fetch and parse the manifest
    const manifestResponse = await fetch(manifestAsset.browser_download_url)
    if (!manifestResponse.ok) {
      return c.json({
        error: true,
        update_available: false,
        error_message: `Failed to fetch manifest: ${manifestResponse.statusText}`,
      })
    }

    const manifest = await manifestResponse.json() as any

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
      return c.json({
        error: true,
        update_available: false,
        error_message: `No app binary found in manifest for ${manifestName}`,
      })
    }

    return c.json({
      error: false,
      update_available: true,
      ota_url: appBinaryUrl,
    })
  } catch (error) {
    return c.json({
      error: true,
      update_available: false,
      error_message: `Error processing manifest: ${error}`,
    })
  }
})

//for koios factory
app.get('/mirror/:encodedURL', async (c) => {
  const encodedURL = c.req.param('encodedURL')
  const url = decodeURIComponent(encodedURL)
  const data = await fetch(url, {
    headers: {
      'User-Agent': 'Koios OTA Updater',
    }
  })
  if (!data.ok) {
    return c.text(`Error fetching data from URL: ${data.statusText}`, 500)
  }

  const buffer = await data.arrayBuffer()

  //return file
  c.res.headers.set('Content-Type', 'application/octet-stream')
  c.res.headers.set('Content-Disposition', `attachment; filename="${url.split('/').pop()}"`)
  c.res.headers.set('Content-Length', buffer.byteLength.toString())
  c.res.headers.set('Cache-Control', 'no-store')

  return c.body(buffer, 200)
})

//MARK: Timezone
app.get('/tz', async (c) => {
  const clientIP = c.req.header("Cf-Connecting-IP");
  const tzinfo = await fetch(`https://api.ipquery.io/${clientIP}`)

  if (!tzinfo.ok) {
    return c.status(500);
  }

  const json = await tzinfo.json() as any;


  //geolocate
  return c.json({
    tzname: json.location.timezone as string
  })
})

export default app
