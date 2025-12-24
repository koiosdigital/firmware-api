import type { Context } from 'hono'
import type { ApiErrorResponse } from './types'
import { StatusCode } from 'hono/utils/http-status'

export function jsonError(c: Context, status: number, message: string) {
    c.status(status as StatusCode)
    return c.json({ error: true, message } satisfies ApiErrorResponse)
}

export function isSafeIdentifier(value: string, opts?: { maxLen?: number }) {
    const maxLen = opts?.maxLen ?? 64
    if (value.length === 0 || value.length > maxLen) return false
    // allow: a-z A-Z 0-9 _ - .
    return /^[A-Za-z0-9_.-]+$/.test(value)
}

export function safeDecodeURIComponent(value: string) {
    try {
        return { ok: true as const, value: decodeURIComponent(value) }
    } catch {
        return { ok: false as const, value: '' }
    }
}

export function sanitizeFilename(input: string) {
    const base = input.trim().split(/[\\/]/).pop() ?? 'download.bin'
    const cleaned = base.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128)
    return cleaned.length ? cleaned : 'download.bin'
}

export function parseSemver(input: string) {
    // Accept "v1.2.3" or "1.2.3". Ignore any prerelease/build metadata.
    const normalized = input.trim().replace(/^v/i, '').split(/[+-]/)[0]
    const parts = normalized.split('.')
    if (parts.length < 1 || parts.length > 3) return null

    const major = Number(parts[0] ?? '')
    const minor = Number(parts[1] ?? '0')
    const patch = Number(parts[2] ?? '0')
    if (![major, minor, patch].every((n) => Number.isInteger(n) && n >= 0)) return null

    return { major, minor, patch }
}

export function compareSemver(a: { major: number; minor: number; patch: number }, b: { major: number; minor: number; patch: number }) {
    if (a.major !== b.major) return a.major - b.major
    if (a.minor !== b.minor) return a.minor - b.minor
    return a.patch - b.patch
}

export function isValidIpAddress(value: string) {
    // minimal, pragmatic validation for IPv4/IPv6 literals
    if (value.includes(':')) {
        return /^[0-9A-Fa-f:]+$/.test(value) && value.length <= 45
    }
    const parts = value.split('.')
    if (parts.length !== 4) return false
    return parts.every((p) => {
        if (!/^\d{1,3}$/.test(p)) return false
        const n = Number(p)
        return n >= 0 && n <= 255
    })
}
