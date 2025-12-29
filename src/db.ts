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
