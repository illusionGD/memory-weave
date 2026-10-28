import 'reflect-metadata';
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

@Module({})
class ApplicationModule {
  static register(config: ServerConfig): DynamicModule {
    const { adminPassword, ...runtimeConfig } = config;
    return {
      module: ApplicationModule,
      controllers: [
        AuthController,
        HealthController,
        SystemController,
        WorkspaceController,
        CompanionsController,
        ConversationsController,
        ReceivingController,
        ModelsController,
      ],
      providers: [
        { provide: SERVER_CONFIG, useValue: runtimeConfig },
        { provide: AuthService, useFactory: () => AuthService.create(adminPassword) },
        { provide: APP_GUARD, useClass: AuthGuard },
        SystemService,
        DatabaseService,
        CompanionsService,
        ConversationsService,
        ReceivingService,
        WorkspaceService,
        ModelConfigurationService,
        ModelRuntimeService,
        ModelProvidersService,
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
