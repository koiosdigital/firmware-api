import type { CachedRelease, GitHubRelease } from './types'

const CACHE_TTL_SECONDS = 300 // 5 minutes

export async function getCachedRelease(
    kv: KVNamespace,
    repoSlug: string
): Promise<GitHubRelease | null> {
    const key = `release:${repoSlug}:latest`
    const cached = await kv.get<CachedRelease>(key, 'json')

    if (!cached) {
        return null
    }

    // Check if cache is still valid
    const age = Date.now() - cached.cached_at
    if (age > CACHE_TTL_SECONDS * 1000) {
        return null
    }

    return cached.release
}

export async function setCachedRelease(
    kv: KVNamespace,
    repoSlug: string,
    release: GitHubRelease
): Promise<void> {
    const key = `release:${repoSlug}:latest`
    const cached: CachedRelease = {
        release,
        cached_at: Date.now(),
    }

    await kv.put(key, JSON.stringify(cached), {
        expirationTtl: CACHE_TTL_SECONDS,
    })
}

export async function invalidateCache(
    kv: KVNamespace,
    repoSlug: string
): Promise<void> {
    const key = `release:${repoSlug}:latest`
    await kv.delete(key)
}
