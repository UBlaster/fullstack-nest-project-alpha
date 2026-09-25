import { shutdownWorker } from '../src/worker/worker-shutdown';

describe('Task 6 shutdown deadline', () => {
	afterEach(() => jest.useRealTimers());
	it.each(['worker', 'app'])('applies the deadline while %s is closing', async (blocked) => {
		jest.useFakeTimers();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const runtime = { close: jest.fn(() => (blocked === 'worker' ? gate : Promise.resolve())) };
		const app = { close: jest.fn(() => (blocked === 'app' ? gate : Promise.resolve())) };
		const timeout = jest.fn();
		const closing = shutdownWorker(runtime, app, timeout);
		try {
			await jest.advanceTimersByTimeAsync(29_999);
			expect(timeout).not.toHaveBeenCalled();
			await jest.advanceTimersByTimeAsync(1);
			expect(timeout).toHaveBeenCalledTimes(1);
		} finally {
			release();
			await closing;
		}
		expect(runtime.close).toHaveBeenCalledTimes(1);
		expect(app.close).toHaveBeenCalledTimes(1);
		expect(jest.getTimerCount()).toBe(0);
	});
	it('still closes app once when worker cleanup rejects', async () => {
		jest.useFakeTimers();
		const runtime = { close: jest.fn().mockRejectedValue(new Error('close failed')) };
		const app = { close: jest.fn().mockResolvedValue(undefined) };
		await expect(shutdownWorker(runtime, app, jest.fn())).rejects.toThrow('close failed');
		expect(app.close).toHaveBeenCalledTimes(1);
		expect(jest.getTimerCount()).toBe(0);
	});
});
