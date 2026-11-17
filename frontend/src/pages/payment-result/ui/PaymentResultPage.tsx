import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PaymentDetails, type Payment } from '../../../features/payments';
import { Layout } from '../../../widgets/layout';

export function PaymentResultPage() {
	const { id } = useParams();
	const [payment, setPayment] = useState<Payment | null>(null);
	const acceptPayment = useCallback((next: Payment) => setPayment(next), []);

	return (
		<Layout>
			<nav className="page-navigation" aria-label="Навигация платежа">
				<Link className="button-link button-secondary" to="/projects">
					← Проекты и workspace
				</Link>
			</nav>
			<section className="card payment-result">
				<h1>Результат тестовой оплаты</h1>
				<p className="muted">
					Статус обновляется после подтверждения ЮKassa. Если результат ещё не появился, обновите
					его или запустите сверку.
				</p>
				{id && <PaymentDetails key={id} id={id} onPayment={acceptPayment} />}
				{payment && payment.id === id && (
					<Link className="button-link" to={`/workspaces/${payment.workspaceId}`}>
						История платежей workspace
					</Link>
				)}
			</section>
		</Layout>
	);
}
