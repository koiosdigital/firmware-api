import type { Project } from './types'

export function buildOpenApiDocument(args: { projects: Project[] }) {
    const { projects } = args

    return {
        openapi: '3.1.0',
        info: {
            title: 'Koios Firmware API',
            version: '2.0.0',
            description: 'Firmware OTA, storage, and diagnostic endpoints for Koios devices.',
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
                    summary: 'List firmware projects',
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
            '/projects/{slug}': {
                get: {
                    summary: 'Get variants for a project',
                    tags: ['Projects'],
                    parameters: [
                        { name: 'slug', in: 'path', required: true, schema: { type: 'string' } },
                    ],
                    responses: {
                        '200': {
                            description: 'Project info and variants',
                            content: {
                                'application/json': {
                                    schema: { $ref: '#/components/schemas/ProjectVariantsResponse' },
                                },
                            },
                        },
                        '404': { description: 'Project not found' },
                        '502': { description: 'Upstream GitHub error' },
                    },
                },
            },
            '/projects/{slug}/{variant}': {
                get: {
                    summary: 'Get manifest for a project variant',
                    tags: ['Projects'],
                    parameters: [
                        { name: 'slug', in: 'path', required: true, schema: { type: 'string' } },
                        { name: 'variant', in: 'path', required: true, schema: { type: 'string' } },
                    ],
                    responses: {
                        '200': {
                            description: 'Firmware manifest JSON (URLs rewritten to absolute)',
                            content: { 'application/json': { schema: { type: 'object' } } },
                        },
                        '404': { description: 'Project/variant not found' },
                        '502': { description: 'Upstream GitHub error' },
                    },
                },
            },
            '/': {
                get: {
                    summary: 'OTA update check (header-driven)',
                    tags: ['OTA'],
                    description:
                        'Requires x-firmware-project and x-firmware-version headers. If project supports variants, also requires x-firmware-variant.',
                    parameters: [
                        { name: 'x-firmware-project', in: 'header', required: true, schema: { type: 'string' } },
                        { name: 'x-firmware-version', in: 'header', required: true, schema: { type: 'string' } },
                        { name: 'x-firmware-variant', in: 'header', required: false, schema: { type: 'string' } },
                        { name: 'x-device-mac-address', in: 'header', required: false, schema: { type: 'string' } },
                        { name: 'x-device-identity', in: 'header', required: false, schema: { type: 'string' } },
                    ],
                    responses: {
                        '200': {
                            description: 'OTA decision',
                            content: { 'application/json': { schema: { $ref: '#/components/schemas/FirmwareUpdateResponse' } } },
                        },
                        '400': { description: 'Missing/invalid headers' },
                        '404': { description: 'Unknown project' },
                        '502': { description: 'Upstream GitHub error' },
                    },
                },
            },
            '/mirror/{encodedURL}': {
                get: {
                    summary: 'Mirror a GitHub download URL (restricted)',
                    tags: ['OTA'],
                    parameters: [
                        { name: 'encodedURL', in: 'path', required: true, schema: { type: 'string' } },
                    ],
                    responses: {
                        '200': { description: 'Binary response' },
                        '400': { description: 'Invalid URL' },
                        '403': { description: 'Host not allowed' },
                    },
                },
            },
            '/firmware/{project}/{variant}/{version}/{filename}': {
                get: {
                    summary: 'Download firmware from R2 storage',
                    tags: ['Storage'],
                    description: 'Serves firmware binaries from Cloudflare R2 storage with immutable caching.',
                    parameters: [
                        { name: 'project', in: 'path', required: true, schema: { type: 'string' } },
                        { name: 'variant', in: 'path', required: true, schema: { type: 'string' } },
                        { name: 'version', in: 'path', required: true, schema: { type: 'string' } },
                        { name: 'filename', in: 'path', required: true, schema: { type: 'string' } },
                    ],
                    responses: {
                        '200': {
                            description: 'Firmware binary',
                            content: { 'application/octet-stream': {} },
                        },
                        '400': { description: 'Invalid parameters' },
                        '404': { description: 'Firmware not found' },
                    },
                },
            },
            '/webhook/github': {
                post: {
                    summary: 'GitHub release webhook',
                    tags: ['Webhooks'],
                    description: 'Receives GitHub release webhook events and syncs firmware to R2 storage. Requires X-Hub-Signature-256 header.',
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
                    description: 'Parses ESP-IDF coredump data and extracts crash information. Returns raw addresses for local addr2line decoding.',
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
                    summary: 'Return client timezone (via IP geolocation)',
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
                    required: ['slug', 'supports_variants', 'repository_slug', 'name'],
                    properties: {
                        slug: { type: 'string' },
                        supports_variants: { type: 'boolean' },
                        repository_slug: { type: 'string' },
                        name: { type: 'string' },
                    },
                },
                ProjectVariantsResponse: {
                    type: 'object',
                    required: ['name', 'repo', 'variants'],
                    properties: {
                        name: { type: 'string' },
                        repo: { type: 'string' },
                        variants: { type: 'array', items: { type: 'string' } },
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
                                ota_url: { type: 'string' },
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
                        tzname: { type: 'string' },
                    },
                },
                GitHubWebhookPayload: {
                    type: 'object',
                    properties: {
                        action: { type: 'string' },
                        release: {
                            type: 'object',
                            properties: {
                                tag_name: { type: 'string' },
                                assets: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            name: { type: 'string' },
                                            browser_download_url: { type: 'string' },
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
                        stored: { type: 'array', items: { type: 'string' } },
                        errors: { type: 'array', items: { type: 'string' } },
                    },
                },
                CoredumpRequest: {
                    type: 'object',
                    required: ['project', 'variant', 'version', 'coredump'],
                    properties: {
                        project: { type: 'string', description: 'Project slug (e.g., "MATRX-fw")' },
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
                                pc: { type: 'string' },
                                registers: {
                                    type: 'object',
                                    additionalProperties: { type: 'string' },
                                },
                            },
                        },
                        backtrace: { type: 'array', items: { type: 'string' } },
                        elf_download_url: { type: 'string' },
                        error: { type: 'string' },
                    },
                },
            },
        },
        tags: [
            { name: 'OTA', description: 'Over-the-air firmware update endpoints' },
            { name: 'Projects', description: 'Firmware project management' },
            { name: 'Storage', description: 'R2 firmware storage' },
            { name: 'Webhooks', description: 'GitHub webhook integration' },
            { name: 'Diagnostics', description: 'Device diagnostic tools' },
            { name: 'Utilities', description: 'Utility endpoints' },
            { name: 'Documentation', description: 'API documentation' },
        ],
    } as const
}
