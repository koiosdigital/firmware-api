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
    },
    {
        slug: 'LANTERN-fw',
        supports_variants: true,
        repository_slug: 'koiosdigital/LANTERN-fw',
        name: 'LANTERN Firmware',
    },
    {
        slug: 'clock-fw',
        supports_variants: true,
        repository_slug: 'koiosdigital/CLOCK-fw',
        name: 'CLOCK Firmware',
    },
    {
        slug: 'tranquil-fw',
        supports_variants: true,
        repository_slug: 'koiosdigital/tranquil-fw',
        name: 'tranquil Firmware',
    }
]