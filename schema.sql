-- Projects table: auto-populated from GitHub webhook releases
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    repository_slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_projects_repository_slug ON projects(repository_slug);

-- Releases table: tracks each variant/version combination
CREATE TABLE IF NOT EXISTS releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    variant TEXT NOT NULL,
    version TEXT NOT NULL,
    major INTEGER NOT NULL,
    minor INTEGER NOT NULL,
    patch INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, variant, version)
);

-- Index for fast latest version lookup (sorted by semver components)
CREATE INDEX IF NOT EXISTS idx_releases_latest ON releases(project_id, variant, major DESC, minor DESC, patch DESC);
