import { HttpException } from '@nestjs/common';
import { API_ERRORS } from '@memory-weave/contracts';
import type { ApiErrorCode } from '@memory-weave/contracts';

/** 业务层只选择共享错误码，HTTP 状态与安全文案统一从 contracts 取得。 */
export class ApiException extends HttpException {
  /** 稳定业务错误码，供各终端判断后续操作。 */
  readonly code: ApiErrorCode;

  /**
   * 构造可对外返回的业务异常，不接收原始错误信息或请求内容。
   * @param code 已在公共错误目录登记的错误码。
   */
  constructor(code: ApiErrorCode) {
    const definition = API_ERRORS[code];
    super(definition.message, definition.statusCode);
    this.code = code;
  }
}
