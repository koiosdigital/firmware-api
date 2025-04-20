import { Hono } from 'hono'
import { projects } from './projects'

const app = new Hono()

app.get('/', async (c) => {
  const project = c.req.header('x-firmware-project')
  const currentVersion = c.req.header('x-firmware-version')
  const projectVariant = c.req.header('x-firmware-variant')

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
    return c.text(`Error fetching asset from GitHub: ${assetName}`, 500)
  }

  const assetURL = asset.browser_download_url

  //split into proto, host, port, and path
  const url = new URL(assetURL)
  const host = url.host
  const port = url.port
  const path = url.pathname
  const proto = url.protocol.replace(':', '')

  return c.json({
    error: false,
    update_available: true,
    ota_url: assetURL,
    //for backwards compatibility
    ota_host: host,
    ota_port: port,
    ota_path: path,
    ota_proto: proto,
  })

})

export default app
