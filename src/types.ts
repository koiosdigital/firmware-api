export interface Project {
    slug: string
    supports_variants: boolean
    repository_slug: string
    name: string
}

export interface GitHubReleaseAsset {
    name: string
    browser_download_url: string
}

export interface GitHubRelease {
    tag_name: string
    assets: GitHubReleaseAsset[]
}

export interface FirmwareManifestPart {
    path?: string
    [key: string]: unknown
}

export interface FirmwareManifestBuild {
    parts?: FirmwareManifestPart[]
    [key: string]: unknown
}

export interface FirmwareManifest {
    builds?: FirmwareManifestBuild[]
    [key: string]: unknown
}

export type FirmwareUpdateResponse =
    | {
        error: false
        update_available: false
    }
    | {
        error: false
        update_available: true
        ota_url: string
    }
    | {
        error: true
        update_available: false
        error_message: string
    }

export type ApiErrorResponse = {
    error: true
    message: string
}
