export class PermanentExportError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = 'PermanentExportError';
	}
}

export class CancelledExportError extends Error {
	constructor() {
		super('Export cancelled');
		this.name = 'CancelledExportError';
	}
}

export class ExportLeaseLostError extends Error {
	constructor() {
		super('Export processing lease lost');
		this.name = 'ExportLeaseLostError';
	}
}
