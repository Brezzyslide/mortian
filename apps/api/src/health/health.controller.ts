import { Controller, Get } from '@nestjs/common';
import { brand, PRODUCT_CODES } from '@project/domain';

@Controller('health')
export class HealthController {
  @Get()
  get(): { status: 'ok'; service: string; products: readonly string[] } {
    return { status: 'ok', service: `${brand.shortName}-api`, products: PRODUCT_CODES };
  }
}
