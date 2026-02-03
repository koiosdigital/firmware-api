import type { Env, FirmwareManifest, ReleaseQueueMessage } from './types'
import { insertRelease, getProcessedAssetIds, markAssetProcessed } from './db'
import { getInstallationToken } from './github'

/**
 * Fetch a GitHub release asset, using authenticated API if token available
 */
async function fetchGitHubAsset(browserUrl: string, apiUrl: string, token?: string): Promise<Response> {
    if (token) {
        return fetch(apiUrl, {
            headers: {
                'User-Agent': 'Koios OTA Updater',
                Authorization: `Bearer ${token}`,
                Accept: 'application/octet-stream',
            },
        })
    }
    return fetch(browserUrl, {
        headers: { 'User-Agent': 'Koios OTA Updater' },
    })
}

/**
 * Build the R2 key for a firmware file
 * Format: firmware/{project}/{variant}/{version}/{filename}
 */
export function buildFirmwareKey(
    project: string,
    variant: string,
    version: string,
    filename: string
): string {
    return `firmware/${project}/${variant}/${version}/${filename}`
}

/**
 * Get firmware binary from R2
 */
export async function getFirmware(
    bucket: R2Bucket,
    project: string,
    variant: string,
    version: string,
    filename: string
): Promise<R2ObjectBody | null> {
    const key = buildFirmwareKey(project, variant, version, filename)
    return bucket.get(key)
}

/**
 * Store firmware binary in R2
 */
export async function storeFirmware(
    bucket: R2Bucket,
    project: string,
    variant: string,
    version: string,
    filename: string,
    data: ArrayBuffer | ReadableStream,
    contentType?: string
): Promise<R2Object> {
    const key = buildFirmwareKey(project, variant, version, filename)
    return bucket.put(key, data, {
        httpMetadata: {
            contentType: contentType ?? 'application/octet-stream',
        },
    })
}

/**
 * Get manifest from R2
 */
export async function getManifest(
    bucket: R2Bucket,
    project: string,
    variant: string,
    version: string
): Promise<FirmwareManifest | null> {
    const key = buildFirmwareKey(project, variant, version, 'manifest.json')
    const object = await bucket.get(key)
    if (!object) {
        return null
    }
    return object.json<FirmwareManifest>()
}

/**
 * Process a single manifest from the queue
 * Downloads manifest, parses it, stores referenced files to R2
 */
export async function processManifest(
    bucket: R2Bucket,
    db: D1Database,
    message: ReleaseQueueMessage,
    env: Env
): Promise<{ stored: string[]; errors: string[] }> {
    const { projectId, projectSlug, version, manifestAssetId, manifestUrl, manifestApiUrl, manifestFilename, assets, installationId } = message
    const stored: string[] = []
    const errors: string[] = []

    // Check if already processed
    const processedIds = await getProcessedAssetIds(db, [manifestAssetId])
    if (processedIds.has(manifestAssetId)) {
        return { stored: [], errors: [] }
    }

    // Get installation token if GitHub App is configured and installation ID is present
    let ghToken: string | undefined
    if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && installationId) {
        ghToken = await getInstallationToken(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, installationId)
    }

    // Build asset lookup map
    const assetMap = new Map(assets.map((a) => [a.name, a]))

    // Parse variant from manifest filename (e.g., "matrx_v9_64x128_manifest.json" -> "matrx_v9_64x128")
    const variant = manifestFilename.replace('_manifest.json', '')

    try {
        // Download and parse the manifest
        const manifestResponse = await fetchGitHubAsset(manifestUrl, manifestApiUrl, ghToken)
        if (!manifestResponse.ok) {
            throw new Error(`Failed to fetch manifest: ${manifestResponse.statusText}`)
        }

        const manifestData = await manifestResponse.arrayBuffer()
        const manifestJson = JSON.parse(new TextDecoder().decode(manifestData)) as FirmwareManifest

        // Normalize chipFamily values (e.g., "esp32s3" -> "ESP32-S3")
        if (manifestJson.builds && Array.isArray(manifestJson.builds)) {
            for (const build of manifestJson.builds) {
                if (build.chipFamily && typeof build.chipFamily === 'string') {
                    build.chipFamily = normalizeChipFamily(build.chipFamily)
                }
            }
        }

        // Store the manifest as "manifest.json" (canonical name)
        const normalizedManifest = new TextEncoder().encode(JSON.stringify(manifestJson)).buffer as ArrayBuffer
        await storeFirmware(bucket, projectSlug, variant, version, 'manifest.json', normalizedManifest, 'application/json')
        stored.push(manifestFilename)

        // Find all referenced files from the manifest
        const referencedFiles = new Set<string>()
        if (manifestJson.builds && Array.isArray(manifestJson.builds)) {
            for (const build of manifestJson.builds) {
                if (build.parts && Array.isArray(build.parts)) {
                    for (const part of build.parts) {
                        if (part.path && typeof part.path === 'string') {
                            referencedFiles.add(part.path)
                        }
                    }
                }
            }
        }

        // Download and store each referenced file
        for (const filename of referencedFiles) {
            const asset = assetMap.get(filename)
            if (!asset) {
                errors.push(`Referenced file not found in release: ${filename}`)
                continue
            }

            const fileResponse = await fetchGitHubAsset(asset.url, asset.apiUrl, ghToken)
            if (!fileResponse.ok) {
                errors.push(`Failed to fetch ${filename}: ${fileResponse.statusText}`)
                continue
            }

            const fileData = await fileResponse.arrayBuffer()
            await storeFirmware(bucket, projectSlug, variant, version, filename, fileData, asset.contentType)
            stored.push(filename)
        }

        // Also store the ELF file if present (for coredump analysis)
        const elfFilename = `${variant}.elf`
        const elfAsset = assetMap.get(elfFilename)
        if (elfAsset) {
            const elfResponse = await fetchGitHubAsset(elfAsset.url, elfAsset.apiUrl, ghToken)
            if (elfResponse.ok) {
                const elfData = await elfResponse.arrayBuffer()
                await storeFirmware(bucket, projectSlug, variant, version, elfFilename, elfData, elfAsset.contentType)
                stored.push(elfFilename)
            }
        }

        // Record release in D1
        await insertRelease(db, projectId, variant, version)

        // Mark manifest as processed
        await markAssetProcessed(db, manifestAssetId, projectId)
    } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error'
        errors.push(`Error processing ${manifestFilename}: ${msg}`)
        throw error // Re-throw so queue can retry
    }

    return { stored, errors }
}

/**
 * Normalize ESP chip family names to proper format
 * e.g., "esp32s3" -> "ESP32-S3", "esp32" -> "ESP32"
 */
function normalizeChipFamily(chipFamily: string): string {
    // Match patterns like esp32, esp32s3, esp32c3, esp32c5, etc.
    return chipFamily.replace(
        /^esp32([a-z]\d)?$/i,
        (_, suffix) => suffix ? `ESP32-${suffix.toUpperCase()}` : 'ESP32'
    )
}
