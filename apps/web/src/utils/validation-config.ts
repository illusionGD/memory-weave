import { z } from 'zod';

// 在业务 schema 构造前关闭 JIT 探测，兼容禁止动态执行代码的生产 CSP。
z.config({ jitless: true });
