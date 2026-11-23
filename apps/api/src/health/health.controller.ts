import { Controller, Get } from '@nestjs/common';
import { brand, PRODUCT_CODES } from '@project/domain';
import { Public } from '../auth/decorators.js';

@Controller('health')
export class HealthController {
  @Public()
  @Get()
  get(): { status: 'ok'; service: string; products: readonly string[] } {
    return { status: 'ok', service: `${brand.shortName}-api`, products: PRODUCT_CODES };
  }
}
