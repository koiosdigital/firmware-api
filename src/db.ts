import type { Project } from './types'

// MARK: - Projects

/**
 * Get all projects from the database
 */
export async function getAllProjects(db: D1Database): Promise<Project[]> {
    const result = await db.prepare('SELECT * FROM projects ORDER BY name').all<Project>()
    return result.results
}

/**
 * Get a project by its slug
 */
export async function getProjectBySlug(db: D1Database, slug: string): Promise<Project | null> {
    const result = await db.prepare('SELECT * FROM projects WHERE slug = ?').bind(slug).first<Project>()
    return result
}

/**
 * Get a project by its repository slug (e.g., "koiosdigital/matrx-fw")
 */
export async function getProjectByRepository(db: D1Database, repositorySlug: string): Promise<Project | null> {
    const result = await db.prepare('SELECT * FROM projects WHERE repository_slug = ?').bind(repositorySlug).first<Project>()
    return result
}

/**
 * Create or update a project from webhook data
 * Returns the project (existing or newly created)
 */
export async function upsertProject(
    db: D1Database,
    repositorySlug: string,
    name: string
): Promise<Project> {
    // Derive slug from repository name (e.g., "koiosdigital/matrx-fw" -> "matrx-fw")
    const slug = repositorySlug.split('/').pop() ?? repositorySlug

    // Try to insert, or update if exists
    await db.prepare(`
        INSERT INTO projects (slug, repository_slug, name, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(repository_slug) DO UPDATE SET
            name = excluded.name,
            updated_at = datetime('now')
    `).bind(slug, repositorySlug, name).run()

    // Return the project
    const project = await getProjectByRepository(db, repositorySlug)
    if (!project) {
        throw new Error('Failed to upsert project')
    }
    return project
}

// MARK: - Releases

/**
 * Parse semver string into components
 */
function parseSemverComponents(version: string): { major: number; minor: number; patch: number } | null {
    const normalized = version.trim().replace(/^v/i, '').split(/[+-]/)[0]
    const parts = normalized.split('.')
    if (parts.length < 1 || parts.length > 3) return null

    const major = Number(parts[0] ?? '')
    const minor = Number(parts[1] ?? '0')
    const patch = Number(parts[2] ?? '0')

    if (![major, minor, patch].every((n) => Number.isInteger(n) && n >= 0)) return null
    return { major, minor, patch }
}

/**
 * Insert a release record (variant + version) for a project
 */
export async function insertRelease(
    db: D1Database,
    projectId: number,
    variant: string,
    version: string
): Promise<void> {
    const semver = parseSemverComponents(version)
    if (!semver) {
        throw new Error(`Invalid semver: ${version}`)
    }

    await db.prepare(`
        INSERT INTO releases (project_id, variant, version, major, minor, patch)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, variant, version) DO NOTHING
    `).bind(projectId, variant, version, semver.major, semver.minor, semver.patch).run()
}

/**
 * Get all variants for a project
 */
export async function getVariants(db: D1Database, projectSlug: string): Promise<string[]> {
    const result = await db.prepare(`
        SELECT DISTINCT r.variant
        FROM releases r
        JOIN projects p ON p.id = r.project_id
        WHERE p.slug = ?
        ORDER BY r.variant
    `).bind(projectSlug).all<{ variant: string }>()

    return result.results.map((r) => r.variant)
}

/**
 * Get the latest version for a project/variant (using indexed semver columns)
 */
export async function getLatestVersion(
    db: D1Database,
    projectSlug: string,
    variant: string
): Promise<string | null> {
    const result = await db.prepare(`
        SELECT r.version
        FROM releases r
        JOIN projects p ON p.id = r.project_id
        WHERE p.slug = ? AND r.variant = ?
        ORDER BY r.major DESC, r.minor DESC, r.patch DESC
        LIMIT 1
    `).bind(projectSlug, variant).first<{ version: string }>()

    return result?.version ?? null
}

export interface VariantInfo {
    variant: string
    latest_version: string
    release_count: number
}

/**
 * Get all variants for a project with their latest version
 */
export async function getVariantsWithLatest(
    db: D1Database,
    projectSlug: string
): Promise<VariantInfo[]> {
    const result = await db.prepare(`
        SELECT
            r.variant,
            (
                SELECT r2.version
                FROM releases r2
                WHERE r2.project_id = r.project_id AND r2.variant = r.variant
                ORDER BY r2.major DESC, r2.minor DESC, r2.patch DESC
                LIMIT 1
            ) as latest_version,
            COUNT(*) as release_count
        FROM releases r
        JOIN projects p ON p.id = r.project_id
        WHERE p.slug = ?
        GROUP BY r.variant
        ORDER BY r.variant
    `).bind(projectSlug).all<VariantInfo>()

    return result.results
}

export interface VersionInfo {
    version: string
    created_at: string
}

/**
 * Get all versions for a project/variant (sorted by semver descending)
 */
export async function getVersions(
    db: D1Database,
    projectSlug: string,
    variant: string
): Promise<VersionInfo[]> {
    const result = await db.prepare(`
        SELECT r.version, r.created_at
        FROM releases r
        JOIN projects p ON p.id = r.project_id
        WHERE p.slug = ? AND r.variant = ?
        ORDER BY r.major DESC, r.minor DESC, r.patch DESC
    `).bind(projectSlug, variant).all<VersionInfo>()

    return result.results
}

// MARK: - Processed Assets

/**
 * Check which asset IDs have already been processed
 */
export async function getProcessedAssetIds(
    db: D1Database,
    assetIds: number[]
): Promise<Set<number>> {
    if (assetIds.length === 0) return new Set()

    const placeholders = assetIds.map(() => '?').join(',')
    const result = await db.prepare(`
        SELECT asset_id FROM processed_assets WHERE asset_id IN (${placeholders})
    `).bind(...assetIds).all<{ asset_id: number }>()

    return new Set(result.results.map((r) => r.asset_id))
}

/**
 * Mark an asset ID as processed
 */
export async function markAssetProcessed(
    db: D1Database,
    assetId: number,
    projectId: number
): Promise<void> {
    await db.prepare(`
        INSERT INTO processed_assets (asset_id, project_id)
        VALUES (?, ?)
        ON CONFLICT(asset_id) DO NOTHING
    `).bind(assetId, projectId).run()
}
