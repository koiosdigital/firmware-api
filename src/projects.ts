export interface Project {
    slug: string
    supports_variants: boolean
    repository_slug: string
    name: string
}

export const projects: Project[] = [
    {
        slug: 'MATRX-fw',
        supports_variants: true,
        repository_slug: 'koiosdigital/MATRX-fw',
        name: 'MATRX Firmware',
    }
]