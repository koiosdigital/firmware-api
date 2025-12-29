import type { FirmwareManifest, GitHubRelease } from './types'
import { insertRelease, getProcessedAssetIds, markAssetProcessed } from './db'

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
 * Download and store release assets from GitHub to R2, and record in D1
 * Only processes manifests that haven't been seen before (by asset ID)
 * Reads each manifest to determine which files to download
 */
export async function syncReleaseToR2(
    bucket: R2Bucket,
    db: D1Database,
    projectId: number,
    projectSlug: string,
    release: GitHubRelease
): Promise<{ stored: string[]; skipped: number; variants: string[]; errors: string[] }> {
    const version = release.tag_name.replace(/^v/i, '')
    const stored: string[] = []
    const variantsSet = new Set<string>()
    const errors: string[] = []

    // Build a map of asset name -> asset for quick lookup
    const assetMap = new Map(release.assets.map((a) => [a.name, a]))

    // Find manifest files (e.g., "matrx_v9_64x128_manifest.json")
    const manifestAssets = release.assets.filter((a) => a.name.endsWith('_manifest.json'))

    // Check which manifests we've already processed
    const manifestIds = manifestAssets.map((a) => a.id)
    const processedIds = await getProcessedAssetIds(db, manifestIds)
    const newManifests = manifestAssets.filter((a) => !processedIds.has(a.id))
    const skipped = manifestAssets.length - newManifests.length

    for (const manifestAsset of newManifests) {
        // Parse variant from manifest filename (e.g., "matrx_v9_64x128_manifest.json" -> "matrx_v9_64x128")
        const variant = manifestAsset.name.replace('_manifest.json', '')
        variantsSet.add(variant)

        try {
            // Download and parse the manifest
            const manifestResponse = await fetch(manifestAsset.browser_download_url, {
                headers: { 'User-Agent': 'Koios OTA Updater' },
            })
            if (!manifestResponse.ok) {
                errors.push(`Failed to fetch ${manifestAsset.name}: ${manifestResponse.statusText}`)
                continue
            }

            const manifestData = await manifestResponse.arrayBuffer()
            const manifestJson = JSON.parse(new TextDecoder().decode(manifestData)) as FirmwareManifest

            // Store the manifest as "manifest.json" (canonical name)
            await storeFirmware(bucket, projectSlug, variant, version, 'manifest.json', manifestData, 'application/json')
            stored.push(manifestAsset.name)

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
                // The manifest references files like "matrx_v9_64x128_bootloader.bin"
                const asset = assetMap.get(filename)
                if (!asset) {
                    errors.push(`Referenced file not found in release: ${filename}`)
                    continue
                }

                const fileResponse = await fetch(asset.browser_download_url, {
                    headers: { 'User-Agent': 'Koios OTA Updater' },
                })
                if (!fileResponse.ok) {
                    errors.push(`Failed to fetch ${filename}: ${fileResponse.statusText}`)
                    continue
                }

                const fileData = await fileResponse.arrayBuffer()
                await storeFirmware(bucket, projectSlug, variant, version, filename, fileData, asset.content_type)
                stored.push(filename)
            }

            // Also store the ELF file if present (for coredump analysis)
            const elfFilename = `${variant}.elf`
            const elfAsset = assetMap.get(elfFilename)
            if (elfAsset) {
                const elfResponse = await fetch(elfAsset.browser_download_url, {
                    headers: { 'User-Agent': 'Koios OTA Updater' },
                })
                if (elfResponse.ok) {
                    const elfData = await elfResponse.arrayBuffer()
                    await storeFirmware(bucket, projectSlug, variant, version, elfFilename, elfData, elfAsset.content_type)
                    stored.push(elfFilename)
                }
            }

            // Mark manifest as processed
            await markAssetProcessed(db, manifestAsset.id, projectId)
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error'
            errors.push(`Error processing ${manifestAsset.name}: ${message}`)
        }
    }

    // Record each variant in D1
    const variants = Array.from(variantsSet)
    for (const variant of variants) {
        try {
            await insertRelease(db, projectId, variant, version)
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error'
            errors.push(`Error recording release ${variant}@${version}: ${message}`)
        }
    }

    return { stored, skipped, variants, errors }
}
