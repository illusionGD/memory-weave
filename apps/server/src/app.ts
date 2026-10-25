import 'reflect-metadata';
import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { ServerConfig } from './config.js';
import { SERVER_CONFIG } from './config.js';
import { AuthGuard } from './modules/auth/auth.guard.js';
import { AuthController } from './modules/auth/auth.controller.js';
import { AuthService } from './modules/auth/auth.service.js';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { createOriginCheck, handleBodyError } from './http-security.js';
import express from 'express';
import { HealthController } from './modules/system/health.controller.js';
import { SystemController } from './modules/system/system.controller.js';
import { SystemService } from './modules/system/system.service.js';
import { attachWebAssets } from './web-assets.js';

@Module({})
class ApplicationModule {
  static register(config: ServerConfig): DynamicModule {
    const { adminPassword, ...runtimeConfig } = config;
    return {
      module: ApplicationModule,
      controllers: [AuthController, HealthController, SystemController],
      providers: [
        { provide: SERVER_CONFIG, useValue: runtimeConfig },
        { provide: AuthService, useFactory: () => AuthService.create(adminPassword) },
        { provide: APP_GUARD, useClass: AuthGuard },
        SystemService,
      ],
    };
  }
}

/**
 * Creates an application without binding a production port, for HTTP acceptance tests.
 * @param config Deployment settings.
 * @returns Initialized Nest HTTP application.
 */
export async function createApplication(config: ServerConfig): Promise<INestApplication> {
  const app = await NestFactory.create(ApplicationModule.register(config), {
    logger: false,
    bodyParser: false,
  });
  app.setGlobalPrefix('api');
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
