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

  const variants = json.assets.map((a: any) => {
    const match = a.name.match(/^(.*)_factory\.zip$/)
    if (match) {
      return {
        name: match[1],
        url: a.browser_download_url,
      }
    }
  }
  ).filter((v: any) => v !== undefined)

  return c.json({
    ...project,
    variants: variants,
  })
})

app.get('/', async (c) => {
  const project = c.req.header('x-firmware-project')
  const currentVersion = c.req.header('x-firmware-version')
  let projectVariant = c.req.header('x-firmware-variant')

  if (!project) {
    return c.text('Missing x-firmware-project header', 400)
  }
  if (!currentVersion) {
    return c.text('Missing x-firmware-version header', 400)
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

  let assetName = "";
  if (projectData.supports_variants) {
    assetName = `${projectVariant}_app.bin`
  } else {
    assetName = `app.bin`
  }

  const asset = json.assets.find((a: any) => a.name === assetName)
  if (!asset) {
    return c.json({
      error: true,
      update_available: false,
      error_message: `No asset found for ${assetName} in release ${json.tag_name}`,
    })
  }

  const assetURL = asset.browser_download_url

  return c.json({
    error: false,
    update_available: true,
    ota_url: assetURL,
  })
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
  c.res.headers.set('Content-Type', 'application/x-x509-ca-cert')
  c.res.headers.set('Content-Disposition', `attachment; filename="${url.split('/').pop()}"`)
  c.res.headers.set('Content-Length', buffer.byteLength.toString())
  c.res.headers.set('Cache-Control', 'no-store')

  return c.body(buffer, 200)
})

//MARK: Timezone
app.get('/tz', async (c) => {
  const clientIP = c.req.header("Cf-Connecting-IP");
  const TZAPIKEY = "10b49e4e1bec4a718155b4c4db6a21b9";

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
