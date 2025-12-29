import type { Project } from './types'

export function buildOpenApiDocument(args: { projects: Project[] }) {
    const { projects } = args

    return {
        openapi: '3.1.0',
        info: {
            title: 'Koios Firmware API',
            version: '3.0.0',
            description: 'Firmware OTA, storage, and diagnostic endpoints for Koios devices. Projects and releases are auto-discovered from GitHub webhooks.',
        },
        paths: {
            '/swagger.json': {
                get: {
                    summary: 'OpenAPI document',
                    tags: ['Documentation'],
                    responses: {
                        '200': { description: 'OpenAPI JSON document' },
                    },
                },
            },
            '/projects': {
                get: {
                    summary: 'List all firmware projects',
                    tags: ['Projects'],
                    responses: {
                        '200': {
                            description: 'Projects list',
                            content: {
                                'application/json': {
                                    schema: {
                                        type: 'array',
                                        items: { $ref: '#/components/schemas/Project' },
                                    },
                                    examples: {
                                        projects: { value: projects },
                                    },
                                },
                            },
                        },
                    },
                },
            },
            '/projects/{project}': {
                get: {
                    summary: 'Get project details with variants',
                    tags: ['Projects'],
                    description: 'Returns project info with all variants and their latest versions.',
                    parameters: [
                        { name: 'project', in: 'path', required: true, schema: { type: 'string' }, description: 'Project slug (e.g., "matrx-fw")' },
                    ],
                    responses: {
                        '200': {
                            description: 'Project info with variants',
                            content: {
                                'application/json': {
                                    schema: { $ref: '#/components/schemas/ProjectDetailsResponse' },
                                },
                            },
                        },
                        '404': { description: 'Project not found' },
                    },
                },
            },
            '/projects/{project}/{variant}': {
                get: {
                    summary: 'Get variant details with all versions',
                    tags: ['Projects'],
                    description: 'Returns variant info with all available versions sorted by semver.',
                    parameters: [
                        { name: 'project', in: 'path', required: true, schema: { type: 'string' }, description: 'Project slug' },
                        { name: 'variant', in: 'path', required: true, schema: { type: 'string' }, description: 'Variant name (e.g., "MATRX_MINI")' },
                    ],
                    responses: {
                        '200': {
                            description: 'Variant info with versions',
                            content: {
                                'application/json': {
                                    schema: { $ref: '#/components/schemas/VariantDetailsResponse' },
                                },
                            },
                        },
                        '404': { description: 'Project or variant not found' },
                    },
                },
            },
            '/projects/{project}/{variant}/{version}': {
                get: {
                    summary: 'Get firmware manifest with absolute URLs',
                    tags: ['Projects'],
                    description: 'Returns the firmware manifest with relative paths transformed to absolute R2 URLs. Response is cached immutably.',
                    parameters: [
                        { name: 'project', in: 'path', required: true, schema: { type: 'string' }, description: 'Project slug' },
                        { name: 'variant', in: 'path', required: true, schema: { type: 'string' }, description: 'Variant name' },
                        { name: 'version', in: 'path', required: true, schema: { type: 'string' }, description: 'Version string' },
                    ],
                    responses: {
                        '200': {
                            description: 'Manifest with absolute URLs',
                            headers: {
                                'Cache-Control': { schema: { type: 'string' }, description: 'public, max-age=31536000, immutable' },
                            },
                            content: {
                                'application/json': {
                                    schema: { $ref: '#/components/schemas/FirmwareManifest' },
                                },
                            },
                        },
                        '400': { description: 'Invalid parameters' },
                        '404': { description: 'Manifest not found' },
                    },
                },
            },
            '/': {
                get: {
                    summary: 'OTA update check (header-driven)',
                    tags: ['OTA'],
                    description:
                        'Checks if a firmware update is available. Requires x-firmware-project and x-firmware-version headers. Use x-firmware-variant for multi-variant projects.',
                    parameters: [
                        { name: 'x-firmware-project', in: 'header', required: true, schema: { type: 'string' }, description: 'Project slug' },
                        { name: 'x-firmware-version', in: 'header', required: true, schema: { type: 'string' }, description: 'Current firmware version (semver)' },
                        { name: 'x-firmware-variant', in: 'header', required: false, schema: { type: 'string' }, description: 'Firmware variant' },
                    ],
                    responses: {
                        '200': {
                            description: 'OTA decision',
                            content: { 'application/json': { schema: { $ref: '#/components/schemas/FirmwareUpdateResponse' } } },
                        },
                        '400': { description: 'Missing/invalid headers' },
                        '404': { description: 'Unknown project or no releases found' },
                    },
                },
            },
            '/webhook/github': {
                post: {
                    summary: 'GitHub release webhook',
                    tags: ['Webhooks'],
                    description: 'Receives GitHub release webhook events. Auto-creates projects and syncs firmware assets to R2 storage. Requires X-Hub-Signature-256 header.',
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/GitHubWebhookPayload' },
                            },
                        },
                    },
                    responses: {
                        '200': {
                            description: 'Webhook processed',
                            content: {
                                'application/json': {
                                    schema: { $ref: '#/components/schemas/WebhookResponse' },
                                },
                            },
                        },
                        '400': { description: 'Invalid payload' },
                        '401': { description: 'Invalid or missing signature' },
                    },
                },
            },
            '/coredump': {
                post: {
                    summary: 'Analyze ESP-IDF coredump',
                    tags: ['Diagnostics'],
                    description: 'Parses ESP-IDF coredump data and extracts crash information. Returns raw addresses for local addr2line decoding with the ELF file.',
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/CoredumpRequest' },
                            },
                        },
                    },
                    responses: {
                        '200': {
                            description: 'Coredump analysis result',
                            content: {
                                'application/json': {
                                    schema: { $ref: '#/components/schemas/CoredumpResponse' },
                                },
                            },
                        },
                        '400': { description: 'Invalid request body' },
                        '404': { description: 'Project not found' },
                    },
                },
            },
            '/tz': {
                get: {
                    summary: 'Get client timezone via IP geolocation',
                    tags: ['Utilities'],
                    responses: {
                        '200': {
                            description: 'Timezone response',
                            content: { 'application/json': { schema: { $ref: '#/components/schemas/TimezoneResponse' } } },
                        },
                        '400': { description: 'Missing/invalid IP' },
                        '502': { description: 'Upstream lookup error' },
                    },
                },
            },
        },
        components: {
            schemas: {
                Project: {
                    type: 'object',
                    required: ['id', 'slug', 'repository_slug', 'name', 'created_at', 'updated_at'],
                    properties: {
                        id: { type: 'integer' },
                        slug: { type: 'string', description: 'Unique project identifier' },
                        repository_slug: { type: 'string', description: 'GitHub repository (e.g., "koiosdigital/matrx-fw")' },
                        name: { type: 'string', description: 'Display name' },
                        created_at: { type: 'string', format: 'date-time' },
                        updated_at: { type: 'string', format: 'date-time' },
                    },
                },
                ProjectDetailsResponse: {
                    type: 'object',
                    required: ['slug', 'name', 'repository', 'variants'],
                    properties: {
                        slug: { type: 'string' },
                        name: { type: 'string' },
                        repository: { type: 'string' },
                        variants: {
                            type: 'array',
                            items: {
                                type: 'object',
                                required: ['name', 'latest_version', 'release_count'],
                                properties: {
                                    name: { type: 'string', description: 'Variant name' },
                                    latest_version: { type: 'string', description: 'Latest semver version' },
                                    release_count: { type: 'integer', description: 'Number of releases for this variant' },
                                },
                            },
                        },
                    },
                },
                VariantDetailsResponse: {
                    type: 'object',
                    required: ['project', 'variant', 'latest_version', 'versions'],
                    properties: {
                        project: { type: 'string' },
                        variant: { type: 'string' },
                        latest_version: { type: 'string' },
                        versions: {
                            type: 'array',
                            items: {
                                type: 'object',
                                required: ['version', 'created_at'],
                                properties: {
                                    version: { type: 'string' },
                                    created_at: { type: 'string', format: 'date-time' },
                                },
                            },
                        },
                    },
                },
                FirmwareUpdateResponse: {
                    oneOf: [
                        {
                            type: 'object',
                            required: ['error', 'update_available'],
                            properties: {
                                error: { const: false },
                                update_available: { const: false },
                            },
                        },
                        {
                            type: 'object',
                            required: ['error', 'update_available', 'ota_url'],
                            properties: {
                                error: { const: false },
                                update_available: { const: true },
                                ota_url: { type: 'string', format: 'uri' },
                            },
                        },
                        {
                            type: 'object',
                            required: ['error', 'update_available', 'error_message'],
                            properties: {
                                error: { const: true },
                                update_available: { const: false },
                                error_message: { type: 'string' },
                            },
                        },
                    ],
                },
                TimezoneResponse: {
                    type: 'object',
                    required: ['tzname'],
                    properties: {
                        tzname: { type: 'string', description: 'IANA timezone name' },
                    },
                },
                GitHubWebhookPayload: {
                    type: 'object',
                    properties: {
                        action: { type: 'string', description: 'Event action (e.g., "published")' },
                        release: {
                            type: 'object',
                            properties: {
                                tag_name: { type: 'string' },
                                name: { type: 'string' },
                                assets: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            name: { type: 'string' },
                                            browser_download_url: { type: 'string' },
                                            content_type: { type: 'string' },
                                        },
                                    },
                                },
                            },
                        },
                        repository: {
                            type: 'object',
                            properties: {
                                full_name: { type: 'string' },
                            },
                        },
                    },
                },
                WebhookResponse: {
                    type: 'object',
                    properties: {
                        message: { type: 'string' },
                        project: { type: 'string' },
                        version: { type: 'string' },
                        stored: { type: 'array', items: { type: 'string' }, description: 'Files stored in R2' },
                        errors: { type: 'array', items: { type: 'string' }, description: 'Any errors encountered' },
                    },
                },
                CoredumpRequest: {
                    type: 'object',
                    required: ['project', 'variant', 'version', 'coredump'],
                    properties: {
                        project: { type: 'string', description: 'Project slug (e.g., "matrx-fw")' },
                        variant: { type: 'string', description: 'Firmware variant (e.g., "MATRX_MINI")' },
                        version: { type: 'string', description: 'Firmware version (e.g., "1.2.3")' },
                        coredump: { type: 'string', description: 'Base64-encoded coredump data' },
                    },
                },
                CoredumpResponse: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean' },
                        crash_info: {
                            type: 'object',
                            properties: {
                                exception_cause: { type: 'string' },
                                pc: { type: 'string', description: 'Program counter (hex)' },
                                registers: {
                                    type: 'object',
                                    additionalProperties: { type: 'string' },
                                },
                            },
                        },
                        backtrace: { type: 'array', items: { type: 'string' }, description: 'Backtrace addresses (hex)' },
                        elf_download_url: { type: 'string', format: 'uri', description: 'URL to download ELF for addr2line' },
                        error: { type: 'string' },
                    },
                },
                FirmwareManifest: {
                    type: 'object',
                    description: 'ESP Web Tools compatible manifest with absolute URLs',
                    properties: {
                        name: { type: 'string', description: 'Firmware name' },
                        version: { type: 'string', description: 'Firmware version' },
                        builds: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    chipFamily: { type: 'string', description: 'Target chip (e.g., "ESP32")' },
                                    parts: {
                                        type: 'array',
                                        items: {
                                            type: 'object',
                                            properties: {
                                                path: { type: 'string', format: 'uri', description: 'Absolute URL to binary file' },
                                                offset: { type: 'integer', description: 'Flash offset in bytes' },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
        tags: [
            { name: 'OTA', description: 'Over-the-air firmware update endpoints' },
            { name: 'Projects', description: 'Firmware project, variant, and manifest discovery' },
            { name: 'Webhooks', description: 'GitHub webhook integration for auto-sync' },
            { name: 'Diagnostics', description: 'Device diagnostic tools' },
            { name: 'Utilities', description: 'Utility endpoints' },
            { name: 'Documentation', description: 'API documentation' },
        ],
    } as const
}
