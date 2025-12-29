import type { FirmwareManifest, GitHubRelease } from './types'
import { insertRelease } from './db'

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
 */
export async function syncReleaseToR2(
    bucket: R2Bucket,
    db: D1Database,
    projectId: number,
    projectSlug: string,
    release: GitHubRelease
): Promise<{ stored: string[]; variants: string[]; errors: string[] }> {
    const version = release.tag_name.replace(/^v/i, '')
    const stored: string[] = []
    const variantsSet = new Set<string>()
    const errors: string[] = []

    for (const asset of release.assets) {
        // Skip non-firmware files
        if (!isFirmwareAsset(asset.name)) {
            continue
        }

        // Parse variant from manifest filename
        const variant = parseVariantFromAsset(asset.name)
        if (!variant) {
            continue
        }

        variantsSet.add(variant)

        try {
            const response = await fetch(asset.browser_download_url, {
                headers: {
                    'User-Agent': 'Koios OTA Updater',
                },
            })

            if (!response.ok) {
                errors.push(`Failed to fetch ${asset.name}: ${response.statusText}`)
                continue
            }

            const data = await response.arrayBuffer()
            await storeFirmware(
                bucket,
                projectSlug,
                variant,
                version,
                asset.name,
                data,
                asset.content_type
            )
            stored.push(asset.name)
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error'
            errors.push(`Error storing ${asset.name}: ${message}`)
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

    return { stored, variants, errors }
}

/**
 * Check if an asset is a firmware-related file
 */
function isFirmwareAsset(filename: string): boolean {
    const firmwareExtensions = ['.bin', '.elf', '_manifest.json']
    return firmwareExtensions.some((ext) => filename.endsWith(ext))
}

/**
 * Parse variant name from asset filename
 * e.g., "MATRX_MINI_manifest.json" -> "MATRX_MINI"
 */
function parseVariantFromAsset(filename: string): string | null {
    if (filename.endsWith('_manifest.json')) {
        return filename.replace('_manifest.json', '')
    }
    // For .bin files, try to extract variant before the extension
    // This is a best-effort match
    const match = filename.match(/^(.+?)(?:[-_]app)?\.bin$/i)
    return match?.[1] ?? null
}
