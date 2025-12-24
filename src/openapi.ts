import type { Project } from './types'

export function buildOpenApiDocument(args: { projects: Project[] }) {
    const { projects } = args

    return {
        openapi: '3.1.0',
        info: {
            title: 'Koios Firmware API',
            version: '1.0.0',
            description: 'Firmware OTA and helper endpoints for Koios devices.',
        },
        paths: {
            '/swagger.json': {
                get: {
                    summary: 'OpenAPI document',
                    responses: {
                        '200': { description: 'OpenAPI JSON document' },
                    },
                },
            },
            '/projects': {
                get: {
                    summary: 'List firmware projects',
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
            '/tz': {
                get: {
                    summary: 'Return client timezone (via IP geolocation)',
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
            },
        },
    } as const
}
