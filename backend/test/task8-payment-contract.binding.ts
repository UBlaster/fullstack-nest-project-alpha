import type { PaymentContractBinding } from './task8-payment-contract.types';

/**
 * Заполните точку подключения после реализации платежей через Stripe или ЮKassa.
 *
 * module и providerToken указывают на ваш Nest-модуль и его DI-токен провайдера.
 * mockProvider подставляет PaymentProviderMock на место платёжного клиента:
 * передайте в mock.create нормализованный запрос, ключ и исходное сохранённое тело,
 * преобразуйте снимок в формат вашего сервиса, а MockProviderUnavailable — в ошибку
 * неизвестного результата. mock.get возвращает текущее состояние операции.
 * notify передаёт повторяемое уведомление в обработчик уже проверенных событий.
 *
 * Примените миграции Task 8 к выделенной локальной БД task8_contract_test.
 * Задайте TASK8_CONTRACT_DATABASE_URL и TASK8_CONTRACT_TESTS=true, затем запустите
 * npm run test:e2e -- --runInBand task8-payment-contract.e2e-spec.ts из backend.
 */
export function paymentContractBinding(): PaymentContractBinding {
	throw new Error('Task 8: настройте подключение мока в test/task8-payment-contract.binding.ts');
}
