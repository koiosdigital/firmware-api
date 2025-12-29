// Cloudflare Worker bindings
export interface Env {
    FIRMWARE: R2Bucket
    DB: D1Database
    GITHUB_WEBHOOK_SECRET: string
}

// Project configuration (from D1 database)
export interface Project {
    id: number
    slug: string
    repository_slug: string
    name: string
    created_at: string
    updated_at: string
}

// GitHub API types
export interface GitHubReleaseAsset {
    name: string
    browser_download_url: string
    size: number
    content_type: string
}

export interface GitHubRelease {
    tag_name: string
    name?: string
    assets: GitHubReleaseAsset[]
    html_url: string
    published_at: string
}

export interface GitHubWebhookPayload {
    action: string
    release?: GitHubRelease
    repository?: {
        full_name: string
    }
}

// Firmware manifest types
export interface FirmwareManifestPart {
    path?: string
    offset?: number
    [key: string]: unknown
}

export interface FirmwareManifestBuild {
    chipFamily?: string
    parts?: FirmwareManifestPart[]
    [key: string]: unknown
}

export interface FirmwareManifest {
    name?: string
    version?: string
    builds?: FirmwareManifestBuild[]
    [key: string]: unknown
}

// API response types
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

export interface ApiErrorResponse {
    error: true
    message: string
}

// Coredump types
export interface CoredumpRequest {
    project: string
    variant: string
    version: string
    coredump: string // Base64-encoded
}

export interface CoredumpResponse {
    success: boolean
    crash_info?: {
        exception_cause?: string
        pc?: string
        registers?: Record<string, string>
    }
    backtrace?: string[]
    elf_download_url?: string
    error?: string
}

