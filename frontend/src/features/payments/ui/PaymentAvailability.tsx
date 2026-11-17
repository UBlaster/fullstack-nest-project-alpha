interface Props {
	enabled: boolean | null;
	failed?: boolean;
}

export function PaymentAvailability({ enabled, failed = false }: Props) {
	if (enabled === true) return null;
	if (enabled === null && !failed) {
		return (
			<p className="muted" role="status">
				Проверяем доступность оплаты…
			</p>
		);
	}
	return (
		<div className="payment-availability" role="status">
			<strong>Тестовая оплата временно недоступна</strong>
			<p className="muted">
				{failed
					? 'Не удалось проверить доступность оплаты. Попробуйте обновить страницу позже.'
					: 'Начать оплату и запустить сверку сейчас нельзя. История платежей доступна.'}
			</p>
		</div>
	);
}
