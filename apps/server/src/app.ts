import { RetrievalService } from './modules/retrieval/retrieval.service';
import { RetrievalController } from './modules/retrieval/retrieval.controller';
import { RetrievalIndexService } from './modules/retrieval/retrieval-index.service';
import { RetrievalVector } from './modules/retrieval/retrieval-vector';
import { MemoriesController } from './modules/memories/memories.controller';
import { MemoriesService } from './modules/memories/memories.service';
import { MemoryExecutionService } from './modules/memories/memory-execution.service';
import { LifecycleController } from './modules/lifecycle/lifecycle.controller';
import { LifecycleService } from './modules/lifecycle/lifecycle.service';
import { LifecycleExecutionService } from './modules/lifecycle/lifecycle-execution.service';
import { ChatEventsService } from './modules/chats/chat-events.service';
import 'reflect-metadata';
import { ChatExecutionService } from './modules/chats/chat-execution.service';
import { ChatContextService } from './modules/chats/chat-context.service';
import { ChatsService } from './modules/chats/chats.service';
import { ChatsController } from './modules/chats/chats.controller';
import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { ServerConfig } from './config';
import { SERVER_CONFIG } from './config';
import { AuthGuard } from './modules/auth/auth.guard';
import { AuthController } from './modules/auth/auth.controller';
import { AuthService } from './modules/auth/auth.service';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { createOriginCheck, handleBodyError } from './http-security';
import express from 'express';
import { HealthController } from './modules/system/health.controller';
import { SystemController } from './modules/system/system.controller';
import { SystemService } from './modules/system/system.service';
import { attachWebAssets } from './web-assets';
import { DatabaseService } from './database/database.service';
import { CompanionsController } from './modules/companions/companions.controller';
import { CompanionsService } from './modules/companions/companions.service';
import { PersonaTemplatesController } from './modules/companions/persona-templates.controller';
import { PersonaTemplatesService } from './modules/companions/persona-templates.service';
import { CompanionPersonasService } from './modules/companions/companion-personas.service';
import { CompanionPersonasController } from './modules/companions/companion-personas.controller';
import { ConversationsController } from './modules/conversations/conversations.controller';
import { ConversationsService } from './modules/conversations/conversations.service';
import { ReceivingController } from './modules/conversations/receiving.controller';
import { ReceivingService } from './modules/conversations/receiving.service';
import { WorkspaceController } from './modules/workspace/workspace.controller';
import { WorkspaceService } from './modules/workspace/workspace.service';
import { ApiExceptionFilter, assignRequestId } from './http/api-exception';
import { ApiResponseInterceptor } from './http/api-response.interceptor';
import { ModelsController } from './modules/models/models.controller';
import { ModelConfigurationService } from './modules/models/model-configuration.service';
import { ModelRuntimeService } from './modules/models/model-runtime.service';
import { ModelProvidersService } from './modules/models/model-providers.service';

import { TaskWorkerService } from './modules/tasks/task-worker.service';
import { TaskOutboxService } from './modules/tasks/task-outbox.service';
import { TaskStore } from './modules/tasks/task-store';
import { TaskConfigurationService } from './modules/tasks/task-configuration.service';
import { TasksService } from './modules/tasks/tasks.service';
import { TasksController } from './modules/tasks/tasks.controller';

@Module({})
class ApplicationModule {
  static register(config: ServerConfig): DynamicModule {
    const { adminPassword, ...runtimeConfig } = config;
    return {
      module: ApplicationModule,
      controllers: [
        RetrievalController,
        MemoriesController,
        AuthController,
        LifecycleController,
        ChatsController,
        HealthController,
        SystemController,
        WorkspaceController,
        CompanionsController,
        PersonaTemplatesController,
        CompanionPersonasController,
        ConversationsController,
        ReceivingController,
        ModelsController,
        TasksController,
      ],
      providers: [
        RetrievalIndexService,
        RetrievalVector,
        RetrievalService,
        { provide: SERVER_CONFIG, useValue: runtimeConfig },
        { provide: AuthService, useFactory: () => AuthService.create(adminPassword) },
        { provide: APP_GUARD, useClass: AuthGuard },
        MemoriesService,
        MemoryExecutionService,
        SystemService,
        LifecycleService,
        LifecycleExecutionService,
        ChatsService,
        ChatExecutionService,
        ChatEventsService,
        ChatContextService,
        DatabaseService,
        CompanionsService,
        PersonaTemplatesService,
        CompanionPersonasService,
        ConversationsService,
        ReceivingService,
        WorkspaceService,
        ModelConfigurationService,
        ModelRuntimeService,
        ModelProvidersService,
        TasksService,
        TaskStore,
        TaskOutboxService,
        TaskWorkerService,
        TaskConfigurationService,
      ],
    };
  }
}

/**
 * 创建并初始化应用，由调用方控制端口监听，便于通过 HTTP 接口进行验收测试。
 * @param config 部署环境配置。
 * @returns 已初始化的 Nest HTTP 应用。
 */
export async function createApplication(config: ServerConfig): Promise<INestApplication> {
  const app = await NestFactory.create(ApplicationModule.register(config), {
    logger: false,
    bodyParser: false,
  });
  app.setGlobalPrefix('api');
  app.use(assignRequestId);
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(new ApiResponseInterceptor());
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          upgradeInsecureRequests: config.appOrigin.startsWith('https://') ? [] : null,
        },
      },
      strictTransportSecurity: config.appOrigin.startsWith('https://'),
    }),
  );
  app.use(createOriginCheck(config.appOrigin));
  // 人设原稿和明确约束可能包含较长中文文本；其他入口继续采用原有体积上限。
  app.use(
    ['/api/companion-creations', '/api/companions', '/api/persona-templates'],
    express.json({ limit: '256kb' }),
  );
  app.use(express.json({ limit: '16kb' }));
  app.use(handleBodyError);
  app.use(cookieParser());
  try {
    if (config.webDistDir) await attachWebAssets(app, config.webDistDir);
    await app.init();
  } catch (error) {
    await app.close();
    throw error;
  }
  return app;
}
