import { ConfigService } from '@nestjs/config';

export function isolatedConfig(values: Record<string, unknown> = {}): ConfigService {
	const config = new ConfigService();
	jest.spyOn(config, 'get').mockImplementation((name) => values[name]);
	return config;
}
