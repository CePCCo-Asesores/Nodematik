export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Chatbox API',
    version: '1.0.0',
    description:
      'Multi-tenant WhatsApp chatbot platform — multi-tenant, LLM-agnostic, BYO credentials. ' +
      'All bot LLM API keys are encrypted at rest (AES-256-GCM) and never logged.',
    contact: { email: 'support@chatbox.app' },
  },
  servers: [{ url: '/api/v1', description: 'Current environment' }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT obtained from POST /auth/login',
      },
      adminKey: {
        type: 'apiKey',
        in: 'header',
        name: 'x-admin-key',
        description: 'Static admin API key (ADMIN_API_KEY env var). Required for superadmin endpoints.',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          details: { type: 'object' },
        },
      },
      Bot: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          orgId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          status: { type: 'string', enum: ['draft', 'active', 'paused', 'credential_error'] },
          llmProvider: { type: 'string', enum: ['openai', 'anthropic'], nullable: true },
          llmModel: { type: 'string', nullable: true },
          safetyLevel: { type: 'string', enum: ['strict', 'standard', 'minimal'] },
          systemPrompt: { type: 'string', nullable: true },
          historyWindow: { type: 'integer', minimum: 0 },
          locale: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      Channel: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          botId: { type: 'string', format: 'uuid' },
          provider: { type: 'string', example: 'meta-cloud' },
          phoneId: { type: 'string' },
          status: { type: 'string', enum: ['connected', 'disconnected', 'error'] },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      KnowledgeItem: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          botId: { type: 'string', format: 'uuid' },
          title: { type: 'string' },
          content: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          hasEmbedding: { type: 'boolean' },
        },
      },
      Organization: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          plan: { type: 'string' },
          monthlyQuota: { type: 'integer' },
          quotaUsed: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      AuditLogEntry: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          action: { type: 'string', example: 'bot.update_credentials' },
          actorId: { type: 'string' },
          actorRole: { type: 'string' },
          targetType: { type: 'string' },
          targetId: { type: 'string' },
          ip: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      DLQJob: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          data: {
            type: 'object',
            properties: {
              phoneId: { type: 'string' },
              waMessageId: { type: 'string' },
              messageType: { type: 'string' },
              timestamp: { type: 'number' },
            },
          },
          failedReason: { type: 'string' },
          attemptsMade: { type: 'integer' },
          addedAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Health check',
        security: [],
        responses: {
          200: { description: 'All dependencies healthy', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, db: { type: 'boolean' }, redis: { type: 'boolean' }, ts: { type: 'number' } } } } } },
          503: { description: 'One or more dependencies degraded' },
        },
      },
    },
    '/metrics': {
      get: {
        tags: ['System'],
        summary: 'Prometheus metrics',
        description: 'Returns metrics in Prometheus text exposition format. Restrict network access in production.',
        security: [],
        responses: {
          200: { description: 'Prometheus text format', content: { 'text/plain': { schema: { type: 'string' } } } },
        },
      },
    },
    '/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Register a new user',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password', 'orgName'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', minLength: 8 },
                  orgName: { type: 'string', minLength: 1 },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'User and org created', content: { 'application/json': { schema: { type: 'object', properties: { token: { type: 'string' }, userId: { type: 'string' }, orgId: { type: 'string' } } } } } },
          409: { description: 'Email already registered', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Authenticate and obtain a JWT',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'JWT token', content: { 'application/json': { schema: { type: 'object', properties: { token: { type: 'string' } } } } } },
          401: { description: 'Invalid credentials', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/admin/bots': {
      get: {
        tags: ['Bots'],
        summary: 'List bots in my org',
        responses: {
          200: { description: 'Bot list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Bot' } } } } },
        },
      },
      post: {
        tags: ['Bots'],
        summary: 'Create a bot',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string' },
                  llmProvider: { type: 'string', enum: ['openai', 'anthropic'] },
                  llmModel: { type: 'string' },
                  llmApiKey: { type: 'string', description: 'Stored encrypted; never returned' },
                  systemPrompt: { type: 'string' },
                  safetyLevel: { type: 'string', enum: ['strict', 'standard', 'minimal'] },
                  historyWindow: { type: 'integer', minimum: 0 },
                  locale: { type: 'string', example: 'es' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Created bot', content: { 'application/json': { schema: { $ref: '#/components/schemas/Bot' } } } },
          400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/admin/bots/{botId}': {
      get: {
        tags: ['Bots'],
        summary: 'Get a bot',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Bot', content: { 'application/json': { schema: { $ref: '#/components/schemas/Bot' } } } },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      put: {
        tags: ['Bots'],
        summary: 'Update a bot',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  llmProvider: { type: 'string' },
                  llmModel: { type: 'string' },
                  llmApiKey: { type: 'string', description: 'Stored encrypted; triggers audit log entry' },
                  systemPrompt: { type: 'string' },
                  safetyLevel: { type: 'string', enum: ['strict', 'standard', 'minimal'] },
                  status: { type: 'string', enum: ['draft', 'active', 'paused'] },
                  historyWindow: { type: 'integer', minimum: 0 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Updated bot', content: { 'application/json': { schema: { $ref: '#/components/schemas/Bot' } } } },
        },
      },
      delete: {
        tags: ['Bots'],
        summary: 'Delete a bot',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          204: { description: 'Deleted' },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/admin/bots/{botId}/channels': {
      get: {
        tags: ['Channels'],
        summary: 'List channels for a bot',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Channel list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Channel' } } } } },
        },
      },
      post: {
        tags: ['Channels'],
        summary: 'Add a Meta Cloud API channel to a bot',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['phoneId', 'accessToken', 'wabaId'],
                properties: {
                  phoneId: { type: 'string', description: 'Meta phone_number_id' },
                  accessToken: { type: 'string', description: 'Stored encrypted' },
                  wabaId: { type: 'string' },
                  apiVersion: { type: 'string', example: 'v21.0' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Channel created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Channel' } } } },
          409: { description: 'Phone ID already registered to another bot' },
        },
      },
    },
    '/admin/bots/{botId}/channels/{channelId}': {
      delete: {
        tags: ['Channels'],
        summary: 'Remove a channel from a bot',
        parameters: [
          { name: 'botId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'channelId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          204: { description: 'Deleted' },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/admin/bots/{botId}/knowledge': {
      get: {
        tags: ['Knowledge'],
        summary: 'List knowledge items for a bot',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Items', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/KnowledgeItem' } } } } },
        },
      },
      post: {
        tags: ['Knowledge'],
        summary: 'Add a knowledge item',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['title', 'content'],
                properties: {
                  title: { type: 'string' },
                  content: { type: 'string' },
                  tags: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/KnowledgeItem' } } } },
        },
      },
    },
    '/admin/bots/{botId}/knowledge/{itemId}': {
      put: {
        tags: ['Knowledge'],
        summary: 'Update a knowledge item (clears embedding if content changes)',
        parameters: [
          { name: 'botId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'itemId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  content: { type: 'string' },
                  tags: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/KnowledgeItem' } } } },
          404: { description: 'Not found' },
        },
      },
      delete: {
        tags: ['Knowledge'],
        summary: 'Delete a knowledge item',
        parameters: [
          { name: 'botId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'itemId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          204: { description: 'Deleted' },
          404: { description: 'Not found' },
        },
      },
    },
    '/admin/bots/{botId}/knowledge/embed': {
      post: {
        tags: ['Knowledge'],
        summary: 'Generate / refresh embeddings for all knowledge items',
        description:
          'Uses the bot\'s OpenAI API key (or a dedicated embeddings integration). ' +
          'Populates both the BYTEA column (in-process fallback) and the pgvector column (ANN search).',
        parameters: [{ name: 'botId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: {
            description: 'Embedding results',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    updated: { type: 'integer' },
                    failed: { type: 'integer' },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
          422: { description: 'No embedding API key configured', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/admin/organizations': {
      get: {
        tags: ['Organizations'],
        summary: 'List organizations (superadmin: all; owner: own)',
        responses: {
          200: { description: 'Org list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Organization' } } } } },
        },
      },
      post: {
        tags: ['Organizations'],
        summary: 'Create an organization',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string' },
                  plan: { type: 'string', example: 'starter' },
                  monthlyQuota: { type: 'integer', minimum: 0 },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Created org', content: { 'application/json': { schema: { $ref: '#/components/schemas/Organization' } } } },
        },
      },
    },
    '/admin/organizations/{id}': {
      get: {
        tags: ['Organizations'],
        summary: 'Get an organization',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Org', content: { 'application/json': { schema: { $ref: '#/components/schemas/Organization' } } } },
          404: { description: 'Not found' },
        },
      },
      put: {
        tags: ['Organizations'],
        summary: 'Update an organization (owner+)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  monthlyQuota: { type: 'integer', minimum: 0 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Updated org', content: { 'application/json': { schema: { $ref: '#/components/schemas/Organization' } } } },
        },
      },
      delete: {
        tags: ['Organizations'],
        summary: 'Delete an organization (superadmin)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          204: { description: 'Deleted' },
          403: { description: 'Forbidden' },
        },
      },
    },
    '/admin/organizations/{id}/members': {
      get: {
        tags: ['Organizations'],
        summary: 'List members of an organization',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: {
            description: 'Member list',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      userId: { type: 'string' },
                      email: { type: 'string' },
                      role: { type: 'string', enum: ['owner', 'admin', 'agent'] },
                    },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ['Organizations'],
        summary: 'Invite a user to the organization',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'role'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  role: { type: 'string', enum: ['admin', 'agent'] },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Member added' },
          409: { description: 'Already a member' },
        },
      },
    },
    '/admin/organizations/{id}/members/{memberId}': {
      put: {
        tags: ['Organizations'],
        summary: 'Change a member\'s role',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'memberId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['role'], properties: { role: { type: 'string', enum: ['admin', 'agent'] } } },
            },
          },
        },
        responses: { 200: { description: 'Role updated' }, 403: { description: 'Cannot change own role or owner role' } },
      },
      delete: {
        tags: ['Organizations'],
        summary: 'Remove a member from the organization',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'memberId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { 204: { description: 'Removed' }, 403: { description: 'Cannot remove self or last owner' } },
      },
    },
    '/admin/organizations/{id}/audit-log': {
      get: {
        tags: ['Organizations'],
        summary: 'Fetch the audit log for an organization (owner+)',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'before', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Cursor for pagination (ISO 8601)' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
        ],
        responses: {
          200: {
            description: 'Audit entries',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    entries: { type: 'array', items: { $ref: '#/components/schemas/AuditLogEntry' } },
                    nextBefore: { type: 'string', format: 'date-time', nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/admin/users/{id}': {
      get: {
        tags: ['Users'],
        summary: 'Get a user (self or admin)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: {
            description: 'User',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    email: { type: 'string' },
                    role: { type: 'string' },
                    paused: { type: 'boolean' },
                    createdAt: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
          404: { description: 'Not found' },
        },
      },
      delete: {
        tags: ['Users'],
        summary: 'ARCO erasure — delete all user data',
        description: 'Deletes the user account and all associated end-user conversation data (LFPDPPP compliance).',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          204: { description: 'Data erased' },
          403: { description: 'Forbidden' },
        },
      },
    },
    '/admin/dlq': {
      get: {
        tags: ['DLQ'],
        summary: 'List DLQ jobs (superadmin)',
        responses: {
          200: { description: 'Jobs', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/DLQJob' } } } } },
        },
      },
    },
    '/admin/dlq/count': {
      get: {
        tags: ['DLQ'],
        summary: 'Get DLQ depth (superadmin)',
        responses: {
          200: { description: 'Count', content: { 'application/json': { schema: { type: 'object', properties: { count: { type: 'integer' } } } } } },
        },
      },
    },
    '/admin/dlq/{jobId}/retry': {
      post: {
        tags: ['DLQ'],
        summary: 'Re-enqueue a DLQ job to the main queue (superadmin)',
        parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Requeued', content: { 'application/json': { schema: { type: 'object', properties: { requeued: { type: 'boolean' }, jobId: { type: 'string' } } } } } },
          404: { description: 'Not found' },
        },
      },
    },
    '/admin/dlq/{jobId}': {
      delete: {
        tags: ['DLQ'],
        summary: 'Discard a DLQ job (superadmin)',
        parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          204: { description: 'Discarded' },
          404: { description: 'Not found' },
        },
      },
    },
  },
};
